// Drop-folder event renderer
//
// System-event cards rendered inline in the chat stream when files arrive
// in ~/robotdojo/user/inbox/ and are processed by the backend watcher.
//
// Contract with backend (Ori):
//   Event types emitted on the same SSE channel as chat deltas:
//     { type: 'file_arrived',    fileId, name }
//     { type: 'file_classified', fileId, name, docType, topicPath }
//     { type: 'file_processed',  fileId, name, summary }          // summary: string
//     { type: 'file_errored',    fileId, name, reason }
//
// Rendering rules:
//   - Cards are NOT user or assistant messages — distinct visual class
//     (.drop-event) with muted background, smaller padding, monospace
//     for file names. Not bold brand blue.
//   - A single file's lifecycle is ONE card, progressively mutated by
//     subsequent events (fileId is the join key).
//   - Idle chat (no streaming message) does NOT auto-scroll. A subtle
//     "new activity" pill near the bottom lets the user jump down.
//
// Security: this component never handles credential values. It only
// displays file metadata from the backend.

const STATE_ORDER = { arrived: 0, classified: 1, processed: 2, errored: 2 };

// Escape HTML — reuses the global helper registered by utils.js. Fall back
// to a local escape if utils.js hasn't loaded (defensive; should not happen
// because utils.js is loaded before the chat module).
function escapeHTML(s) {
  if (typeof esc === 'function') return esc(s);
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function isNearChatBottom(container) {
  if (!container) return true;
  return container.scrollHeight - container.scrollTop - container.clientHeight < 120;
}

function renderCardHTML(entry) {
  const name = escapeHTML(entry.name || '');
  const topicPath = escapeHTML(entry.topicPath || '');
  const docType = escapeHTML(entry.docType || '');
  const reason = escapeHTML(entry.reason || '');
  const summary = escapeHTML(entry.summary || '');

  const lines = [];

  // Line 1: arrival (always present)
  const arrivedLine = entry.state === 'arrived'
    ? `<span class="drop-event-icon" aria-hidden="true">📥</span><span class="drop-event-text">Processing <code class="drop-event-file">${name}</code><span class="drop-event-dots" aria-hidden="true">…</span></span>`
    : `<span class="drop-event-icon" aria-hidden="true">📥</span><span class="drop-event-text">Received <code class="drop-event-file">${name}</code></span>`;
  lines.push(`<div class="drop-event-line drop-event-line--arrived">${arrivedLine}</div>`);

  // Line 2: classification
  if (entry.docType || entry.topicPath) {
    lines.push(
      `<div class="drop-event-line drop-event-line--classified">` +
        `<span class="drop-event-icon" aria-hidden="true">🔍</span>` +
        `<span class="drop-event-text">` +
          (docType ? `Classified as <span class="drop-event-type">${docType}</span>` : 'Classified') +
          (topicPath ? ` → <code class="drop-event-path">${topicPath}</code>` : '') +
        `</span>` +
      `</div>`
    );
  }

  // Line 3: processed summary
  if (entry.summary) {
    lines.push(
      `<div class="drop-event-line drop-event-line--processed">` +
        `<span class="drop-event-icon" aria-hidden="true">✓</span>` +
        `<span class="drop-event-text">Extracted: ${summary}</span>` +
      `</div>`
    );
  }

  // Line 3 (alt): error
  if (entry.state === 'errored') {
    lines.push(
      `<div class="drop-event-line drop-event-line--errored">` +
        `<span class="drop-event-icon" aria-hidden="true">⚠︎</span>` +
        `<span class="drop-event-text">Failed: ${reason || 'Unknown error'}</span>` +
      `</div>`
    );
  }

  return lines.join('');
}

// --- Factory ------------------------------------------------------------

export function createDropEventsRenderer(opts) {
  const container = opts?.container || document.getElementById('messagesInner');
  const scroller = opts?.scroller  || document.getElementById('messages');
  const isStreaming = opts?.isStreaming || (() => false);
  if (!container) {
    console.warn('[drop-events] no container provided');
    return { handleEvent() {}, destroy() {} };
  }

  // fileId -> { el, name, state, docType, topicPath, summary, reason }
  const cards = new Map();
  let activityPill = null;
  let pillHideTimer = null;

  function ensureActivityPill() {
    if (activityPill && document.body.contains(activityPill)) return activityPill;
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'drop-event-activity-pill';
    pill.setAttribute('aria-live', 'polite');
    pill.textContent = 'New activity';
    pill.addEventListener('click', () => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      hideActivityPill();
    });
    // Attach inside the scroller's offsetParent so it floats relative to chat
    const host = scroller?.parentElement || document.body;
    host.appendChild(pill);
    activityPill = pill;
    return pill;
  }

  function showActivityPill() {
    const pill = ensureActivityPill();
    pill.classList.add('drop-event-activity-pill--visible');
    clearTimeout(pillHideTimer);
    pillHideTimer = setTimeout(hideActivityPill, 8000);
  }

  function hideActivityPill() {
    if (!activityPill) return;
    activityPill.classList.remove('drop-event-activity-pill--visible');
    clearTimeout(pillHideTimer);
  }

  function createCard(entry) {
    const el = document.createElement('div');
    el.className = 'drop-event';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.dataset.fileId = entry.fileId;
    el.dataset.state = entry.state;
    el.innerHTML = renderCardHTML(entry);
    return el;
  }

  function updateCard(entry) {
    const card = cards.get(entry.fileId);
    if (!card) return;
    card.el.dataset.state = entry.state;
    card.el.innerHTML = renderCardHTML(entry);
  }

  function advanceState(prev, next) {
    if (!prev) return next;
    return STATE_ORDER[next] >= STATE_ORDER[prev] ? next : prev;
  }

  function handleEvent(event) {
    if (!event || typeof event !== 'object') return;
    const { type, fileId, name } = event;
    if (!fileId) return;

    let entry = cards.get(fileId);
    const wasNearBottom = isNearChatBottom(scroller);

    if (type === 'file_arrived') {
      if (entry) {
        entry.name = name ?? entry.name;
        entry.state = advanceState(entry.state, 'arrived');
        updateCard(entry);
      } else {
        entry = { fileId, name: name || '', state: 'arrived' };
        entry.el = createCard(entry);
        cards.set(fileId, entry);
        container.appendChild(entry.el);
      }
    } else if (type === 'file_classified') {
      if (!entry) {
        entry = { fileId, name: name || '', state: 'classified' };
        entry.el = createCard(entry);
        cards.set(fileId, entry);
        container.appendChild(entry.el);
      }
      entry.name = name ?? entry.name;
      entry.docType = event.docType ?? entry.docType;
      entry.topicPath = event.topicPath ?? entry.topicPath;
      entry.state = advanceState(entry.state, 'classified');
      updateCard(entry);
    } else if (type === 'file_processed') {
      if (!entry) {
        entry = { fileId, name: name || '', state: 'processed' };
        entry.el = createCard(entry);
        cards.set(fileId, entry);
        container.appendChild(entry.el);
      }
      entry.name = name ?? entry.name;
      entry.summary = event.summary ?? entry.summary;
      entry.state = advanceState(entry.state, 'processed');
      updateCard(entry);
    } else if (type === 'file_errored') {
      if (!entry) {
        entry = { fileId, name: name || '', state: 'errored' };
        entry.el = createCard(entry);
        cards.set(fileId, entry);
        container.appendChild(entry.el);
      }
      entry.name = name ?? entry.name;
      entry.reason = event.reason ?? entry.reason;
      entry.state = 'errored';
      updateCard(entry);
    } else {
      return;
    }

    // Auto-scroll only if user was already near the bottom OR actively
    // streaming (they're watching the tail). Otherwise surface a pill.
    if (wasNearBottom || isStreaming()) {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    } else {
      showActivityPill();
    }
  }

  function destroy() {
    cards.clear();
    clearTimeout(pillHideTimer);
    if (activityPill && activityPill.parentElement) activityPill.remove();
    activityPill = null;
  }

  return { handleEvent, destroy };
}

// Convenience: check if an SSE payload belongs to this component.
export function isDropEvent(d) {
  return d && typeof d.type === 'string' && (
    d.type === 'file_arrived' ||
    d.type === 'file_classified' ||
    d.type === 'file_processed' ||
    d.type === 'file_errored'
  );
}
