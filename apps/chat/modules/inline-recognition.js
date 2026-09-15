// Inline entity recognition for chat input (st_f1a40461 AC9).
//
// This is the SOLE surviving entity surface in the chat input after the @-mention
// person-search autocomplete was removed (st_fd14cdd4 follow-up, 2026-06-13). It
// paints entities from a bounded, debounced typing-time lookup and from the chat
// stream's `entity_recognized` SSE frame. No @ picker, no chips, no vector/model
// work while typing. Black Belt only — the entity graph (N2 classification,
// scoring) is not available in White Belt.

let knownInlineMatches = [];
let lookupTimer = null;
let lookupAbortController = null;
let lookupSeq = 0;

const INLINE_LOOKUP_MIN_CHARS = 3;
const INLINE_LOOKUP_DEBOUNCE_MS = 250;
const INLINE_LOOKUP_TEXT_LIMIT = 8000;
const INLINE_LOOKUP_SEPARATOR = '\n...\n';

function isBlackBelt() { return (window._currentBelt || 'white') === 'black'; }

function setInlineDebug(patch) {
  try {
    window.__rdInlineRecognitionDebug = {
      ...(window.__rdInlineRecognitionDebug || {}),
      ...patch,
      updatedAt: Date.now(),
    };
  } catch { /* debug state is best-effort */ }
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function entityHighlightNames(item) {
  const names = [item?.name, ...(Array.isArray(item?.aliases) ? item.aliases : [])]
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  return [...new Set(names.map((name) => name.toLowerCase()))]
    .map((lower) => names.find((name) => name.toLowerCase() === lower));
}

// Drop matches whose name no longer appears in the textarea, then merge in the
// newly recognized set. Keeps the highlight set in sync with edits/deletions so
// a name the user removed stops being highlighted.
function mergeInlineMatches(matches, ta) {
  const text = ta?.value || '';
  const byKey = new Map();
  for (const item of knownInlineMatches) {
    if (entityHighlightNames(item).some((name) => text.toLowerCase().includes(name.toLowerCase()))) {
      byKey.set(`${item.type}:${item.id}`, item);
    }
  }
  for (const item of matches || []) {
    if (!item?.id || !item?.name) continue;
    byKey.set(`${item.type}:${item.id}`, item);
  }
  knownInlineMatches = [...byKey.values()];
}

// Build the highlighter overlay HTML: wrap each recognized name's word-bounded
// occurrences in a <mark>, escaping the surrounding text. Overlapping ranges are
// resolved left-to-right, longest-first, so nested names never double-wrap.
function highlightedHtml(text, matches) {
  if (!text) return '';
  const ranges = [];
  for (const item of matches || []) {
    for (const name of entityHighlightNames(item)) {
      const re = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');
      let match;
      while ((match = re.exec(text)) !== null) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
      }
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);

  const accepted = [];
  let cursor = -1;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    accepted.push(range);
    cursor = range.end;
  }

  let html = '';
  let pos = 0;
  for (const range of accepted) {
    html += escapeHtml(text.slice(pos, range.start));
    html += `<mark class="passive-entity-inline">${escapeHtml(text.slice(range.start, range.end))}</mark>`;
    pos = range.end;
  }
  html += escapeHtml(text.slice(pos));
  return html.replace(/\n$/u, '\n ');
}

// Repaint the highlighter layer that sits behind the textarea. The layer scroll
// position is kept in lockstep with the textarea so highlights stay aligned.
function renderInlineHighlights(ta) {
  const wrap = ta?.closest?.('.entity-highlight-wrap');
  const layer = wrap?.querySelector?.('.passive-entity-highlighter');
  if (!wrap || !layer) return;

  mergeInlineMatches([], ta);
  const text = ta.value || '';
  const html = highlightedHtml(text, knownInlineMatches);
  const hasMarks = /passive-entity-inline/.test(html);
  // Empty when nothing is recognized so a transparent textarea cannot show a
  // second copy of the typed string through the overlay.
  layer.innerHTML = hasMarks ? html : '';
  layer.scrollTop = ta.scrollTop;
  layer.scrollLeft = ta.scrollLeft;
  wrap.classList.toggle('has-entity-highlight', hasMarks);
  setInlineDebug({ markCount: hasMarks ? layer.querySelectorAll('.passive-entity-inline').length : 0 });
}

function abortInlineLookup() {
  if (lookupTimer) {
    clearTimeout(lookupTimer);
    lookupTimer = null;
  }
  if (lookupAbortController) {
    try { lookupAbortController.abort(); } catch {}
    lookupAbortController = null;
  }
}

function buildInlineLookupText(text) {
  const value = String(text || '');
  if (value.length <= INLINE_LOOKUP_TEXT_LIMIT) return value;
  const budget = INLINE_LOOKUP_TEXT_LIMIT - INLINE_LOOKUP_SEPARATOR.length;
  const head = Math.max(1, Math.floor(budget / 2));
  const tail = Math.max(1, budget - head);
  return `${value.slice(0, head)}${INLINE_LOOKUP_SEPARATOR}${value.slice(-tail)}`;
}

function scheduleInlineLookup(ta) {
  lookupSeq += 1;
  const seq = lookupSeq;
  if (!isBlackBelt()) {
    setInlineDebug({ stage: 'skipped_belt', seq });
    abortInlineLookup();
    return;
  }
  const text = String(ta?.value || '');
  if (text.trim().length < INLINE_LOOKUP_MIN_CHARS) {
    setInlineDebug({ stage: 'skipped_short', seq, inputLength: text.length });
    abortInlineLookup();
    return;
  }
  setInlineDebug({ stage: 'scheduled', seq, inputLength: text.length });
  if (lookupTimer) clearTimeout(lookupTimer);
  lookupTimer = setTimeout(async () => {
    lookupTimer = null;
    if (lookupAbortController) {
      try { lookupAbortController.abort(); } catch {}
    }
    const ac = new AbortController();
    lookupAbortController = ac;
    try {
      setInlineDebug({ stage: 'fetching', seq });
      const res = await fetch('/api/chat/inline-entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: buildInlineLookupText(text) }),
        signal: ac.signal,
      });
      setInlineDebug({ stage: 'fetched', seq, status: res.status, ok: res.ok });
      if (seq !== lookupSeq || !res.ok) return;
      const data = await res.json().catch(() => ({}));
      setInlineDebug({ stage: 'parsed', seq, entityCount: Array.isArray(data?.entities) ? data.entities.length : 0 });
      if (seq !== lookupSeq) return;
      surfaceRecognizedEntities(data?.entities || [], ta);
    } catch (err) {
      setInlineDebug({ stage: 'error', seq, error: err?.message || String(err) });
      if (err?.name !== 'AbortError') console.warn('[chat] inline entity lookup failed:', err.message);
    } finally {
      if (lookupAbortController === ac) lookupAbortController = null;
    }
  }, INLINE_LOOKUP_DEBOUNCE_MS);
}

// Bind the input box to the inline-recognition surface. Repaints on input and
// scroll (so highlights track text edits and scrolling), runs a bounded
// debounced entity lookup, then subscribes to chat stream recognition frames.
export function bindInlineRecognition(ta) {
  ta.addEventListener('input', () => {
    renderInlineHighlights(ta);
    scheduleInlineLookup(ta);
  });
  ta.addEventListener('scroll', () => renderInlineHighlights(ta));
  bindRecognitionStream(ta);
}

// Track which textareas already have a recognition subscription so a re-render
// of the input box doesn't stack duplicate handlers.
const _recognitionBound = new WeakSet();

/**
 * Paint the server's recognized-entity set into the inline-highlight layer. The
 * chat stream delivers an `entity_recognized` frame ({ entities: [{id,name,type,
 * n2,score}] }); this normalizes it to the {type,id,name} shape the highlighter
 * consumes, then re-dispatches a `robotdojo:entity-recognized` CustomEvent per
 * entity for any listeners.
 */
function surfaceRecognizedEntities(entities, ta) {
  if (!isBlackBelt() || !Array.isArray(entities) || !entities.length) return;
  const matches = entities
    .map((e) => ({
      type: e.type || 'person',
      id: e.id != null ? String(e.id) : '',
      name: e.name || e.display_name || '',
      aliases: [e.matched_name, e.match_text, e.match].filter(Boolean),
    }))
    .filter((e) => e.id && e.name);
  if (!matches.length) return;
  setInlineDebug({ stage: 'surfacing', surfaceCount: matches.length });
  mergeInlineMatches(matches, ta);
  renderInlineHighlights(ta);
  for (const entity of matches) {
    try {
      ta.dispatchEvent(new CustomEvent('robotdojo:entity-recognized', { detail: entity }));
    } catch { /* dispatch is best-effort */ }
  }
}

/**
 * Subscribe to the chat event bus for `entity_recognized` frames. The chat
 * stream consumer (apps/chat/modules/chat.js handleSSEEvent) forwards ambient
 * frames to window.__chatEventBus; this handler renders them on the inline
 * recognition path. Idempotent per textarea.
 */
function bindRecognitionStream(ta) {
  if (!ta || _recognitionBound.has(ta)) return;
  _recognitionBound.add(ta);
  const handler = (evt) => {
    const entities = evt?.entities || evt?.detail?.entities;
    surfaceRecognizedEntities(entities, ta);
  };
  try {
    window.__chatEventBus?.on?.('entity_recognized', handler);
  } catch { /* bus not ready — document fallback below still applies */ }
  // Fallback channel: a document-level CustomEvent, in case the chat client
  // re-dispatches recognition frames there rather than via the bus.
  document.addEventListener('robotdojo:chat-entity-recognized', (e) => {
    handler(e?.detail || e);
  });
}
