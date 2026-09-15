// Chat app — orchestrator (imports from modules, wires events, boots)

import {
  models, selectedModel, touchStartX,
  setModels, setSelectedModel, setLabels, setInboxCount, setThinkingLevel,
  setTouchStartX, sending, abortController, selectedConversations,
  cachedConvs, currentConvId, attachedFiles, setUrlContext,
  setAgentName,
} from './modules/state.js';

import {
  loadConversations, showListView, newConversation, newActionConversation, switchNavItem,
  loadConversation, loadConversationAndHighlight,
  renderLabels, renameLabel, removeLabel,
  renderSearchResults, renderMessages,
  toggleSelectAll, bulkArchive, bulkStar, bulkDelete,
  quickArchive, quickDelete, toggleStar,
  editMessage, deleteMessage, showMsgContextMenu, doSend, updateUsage,
  showConfirmModal, showPromptModal, closeModal, toggleHelp, closeHelp,
  openContextMenu, closeContextMenu, handleCtx,
  toggleConvDetailMenu, closeConvDetailMenu,
  updateGreeting, updateBulkBar,
  reloadLabelsAndConvs, startThread, sendThreadReply, doSearch,
  openTopicLive, openTopicHistory,
} from './modules/chat.js?v=2026-09-13-4';

import { closeDropdown, handleFiles, renderFileChips, removeFile, buildModelDropdown, cycleModel, buildInputBox, bindInputEvents } from './modules/input.js?v=2026-09-09-3';

import { createDropEventsRenderer } from './components/drop-events.js';
import { createSecureInputController } from './components/secure-input-overlay.js';
import { readWarmPayload, writeWarmPayload } from './modules/warm-cache.js';
import { initTopicStore } from './modules/topic-store.js?v=2026-09-08-9';

function markAppReady() {
  if (window.RobotDojoBootFallback) {
    clearTimeout(window.RobotDojoBootFallback);
    window.RobotDojoBootFallback = null;
  }
  document.querySelectorAll('.rd-boot-fallback').forEach((el) => el.remove());
  document.body.classList.remove('app-boot-fallback');
  if (window.RobotDojoComponents?.setAppReady) window.RobotDojoComponents.setAppReady();
  else document.body.classList.add('app-ready');
}

function setLoadStatus(message) {
  const el = document.getElementById('chatLoadStatus');
  if (!el || !message) return;
  const text = el.querySelector('.chat-load-text') || el;
  text.textContent = message;
  el.hidden = false;
}

function clearLoadStatus() {
  const el = document.getElementById('chatLoadStatus');
  if (el) el.hidden = true;
}

// st_96bb626f AC 11 — report a setup-context load failure to the server log,
// fire-and-forget, so the operator can see WHY a URL-driven context file
// didn't load without ever blocking or blanking the chat. Best-effort: a
// failed log POST is swallowed and never surfaces to the user.
function logContextFailure(reason, detail) {
  try {
    fetch('/api/chat/context-failure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: String(reason || ''), detail: String(detail || '') }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* logging is best-effort */ }
}

window.RobotDojoLoadStatus = {
  set: setLoadStatus,
  clear: clearLoadStatus,
};

window.RobotDojoChatRuntime = {
  isStreaming: () => !!sending,
};

function applyWarmChatBootData() {
  const warmModels = readWarmPayload('rd_warm_models');
  const warmPrefs = readWarmPayload('rd_warm_preferences');
  if (Array.isArray(warmModels) && warmModels.length) {
    setModels(warmModels);
    const next = warmModels.find((m) => m.key === 'grok-4.3')?.key
      || (warmModels.some((m) => m.key === selectedModel) ? selectedModel : null)
      || warmModels[0]?.key;
    if (next) setSelectedModel(next);
    setThinkingLevel(warmModels.find(m => m.key === selectedModel)?.tier === 0 ? 'high' : 'medium');
  }
  if (warmPrefs?.agent_name) setAgentName(warmPrefs.agent_name);
}

// ─── Chat Event Bus ───────────────────────────────────────────────
// Ambient events (drop-folder file_* and secure_input) arrive on the chat
// SSE stream inside modules/chat.js. chat.js forwards them to this bus;
// components register handlers keyed by event.type. An optional ambient
// EventSource (below) lets these events arrive even when no chat stream
// is active (e.g. user drops a file while reading).

const _eventBusHandlers = new Map(); // type -> Set<fn>
window.__chatEventBus = {
  on(type, fn) {
    if (!_eventBusHandlers.has(type)) _eventBusHandlers.set(type, new Set());
    _eventBusHandlers.get(type).add(fn);
    return () => _eventBusHandlers.get(type)?.delete(fn);
  },
  dispatch(event) {
    if (!event || typeof event.type !== 'string') return;
    const set = _eventBusHandlers.get(event.type);
    if (!set) return;
    for (const fn of set) {
      try { fn(event); } catch (err) { console.error('[event-bus]', event.type, err); }
    }
  },
};

// ─── Event Delegation ─────────────────────────────────────────────

const actions = {
  sidebarNewItem: () => newConversation(),
  closeSidebar: () => toggleSidebar(false),
  showListView: () => newConversation(),
  toggleConvDetailMenu,
  toggleHelp, closeHelp, closeModal,
  loadConversation: (e, el) => loadConversation(el.dataset.id),
  loadConversationAndHighlight: (e, el) => loadConversationAndHighlight(el.dataset.id),
  toggleConvSelect: (e, el) => { e.stopPropagation(); toggleConvSelectAction(el.dataset.id, el); },
  toggleStar: (e, el) => { e.stopPropagation(); toggleStar(el.dataset.id, parseInt(el.dataset.pinned)); },
  quickArchive: (e, el) => { e.stopPropagation(); quickArchive(el.dataset.id); },
  quickDelete: (e, el) => { e.stopPropagation(); quickDelete(el.dataset.id); },
  openContextMenu: (e, el) => openContextMenu(e, el.dataset.id, el.dataset.pinned === 'true'),
  toggleSelectAll, bulkArchive, bulkStar, bulkDelete,
  editMessage: (e, el) => editMessage(parseInt(el.dataset.idx)),
  deleteMessage: (e, el) => deleteMessage(parseInt(el.dataset.idx)),
  showMsgContextMenu: (e, el) => showMsgContextMenu(e, parseInt(el.dataset.idx)),
  deleteMessageAndClose: (e, el) => { deleteMessage(parseInt(el.dataset.idx)); el.closest('.context-menu')?.remove(); },
  editMessageAndClose: (e, el) => { editMessage(parseInt(el.dataset.idx)); el.closest('.context-menu')?.remove(); },
  startThread: (e, el) => startThread(parseInt(el.dataset.seq)),
  sendThreadReply: (e, el) => sendThreadReply(parseInt(el.dataset.seq)),
  removeFile: (e, el) => removeFile(parseInt(el.dataset.idx)),
  renameLabelAction: (e, el) => { closeContextMenu(); renameLabel(el.dataset.context || el.dataset.id, el.dataset.name); },
  removeLabelAction: (e, el) => { closeContextMenu(); removeLabel(el.dataset.context || el.dataset.id); },
  searchResultClick: (e, el) => { loadConversationAndHighlight(el.dataset.id); closePersistentSearchResults(); },
  copyError: (e, el) => { navigator.clipboard.writeText(el.dataset.error); el.classList.add('copied'); setTimeout(() => el.classList.remove('copied'), 1200); },
  copyPipelineError: (e, el) => { navigator.clipboard.writeText(el.textContent); showToast('Copied'); },
  toggleThinking: (e, el) => {
    const container = el.closest('.ttft-progress') || el.closest('.tool-trace');
    if (!container) return;
    const steps = container.querySelector('.thinking-steps');
    const chevron = el.querySelector('.thinking-chevron');
    if (!steps) return;
    const expanding = steps.hasAttribute('hidden');
    steps.toggleAttribute('hidden', !expanding);
    if (chevron) chevron.textContent = expanding ? '▾' : '▸';
  },
};

document.addEventListener('click', e => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (target.dataset.selfOnly === 'true' && e.target !== target) return;
  const handler = actions[action];
  if (handler) { if (target.dataset.stop === 'true') e.stopPropagation(); handler(e, target); }
});

document.addEventListener('contextmenu', e => {
  const msg = e.target.closest('[data-ctx-idx]');
  if (!msg) return;
  showMsgContextMenu(e, parseInt(msg.dataset.ctxIdx));
});

// Thread textarea Enter-to-send
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  const ta = e.target.closest('.thread-input-field[data-seq]');
  if (!ta) return;
  e.preventDefault();
  sendThreadReply(parseInt(ta.dataset.seq));
});

// ─── Keyboard ─────────────────────────────────────────────────────

function toggleConvSelectAction(id, checkbox) {
  const rows = Array.from($$('#convListBody .conv-list-row'));
  const row = rows.find(r => r._convId === id);
  if (!row) return;
  if (checkbox && checkbox.checked) { selectedConversations.add(id); row.classList.add('selected'); }
  else { selectedConversations.delete(id); row.classList.remove('selected'); }
  updateBulkBar();
}

function getTopicNavRows() {
  return Array.from($$('#topicList .label-item')).filter((el) => !el.classList.contains('label-group-parent'));
}

function handleKeys(e) {
  const inInput = e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT' || e.target.isContentEditable;

  const runShortcutAction = (action) => {
    const actions = {
      new_chat: () => newConversation(),
      focus_prompt: () => { const ta = $('.chat-input'); if (ta) ta.focus(); },
      cycle_model: () => cycleModel(),
      attach_file: () => { const f = $('.input-toolbar input[type=file]'); if (f) f.click(); },
      navigate_down: () => kbNavMove(1),
      navigate_up: () => kbNavMove(-1),
      open_selected: () => kbOpenHighlighted(),
      return_to_list: () => newConversation(),
      archive: () => kbArchive(),
      delete: () => { const id = currentConvId; if (id) quickDelete(id); },
      star: () => kbToggleStar(),
      label_topic: () => { closeDropdown(); const td = $('#topicDropdown'); if (td) td.classList.toggle('open'); },
      help: () => toggleHelp(),
      close: () => {
        if (inInput) { document.activeElement?.blur(); return; }
        if ($('#helpModal').classList.contains('open')) { closeHelp(); return; }
        if (sending && abortController) { abortController.abort(); return; }
        closeContextMenu(); closeDropdown(); closeModal(); closeConvDetailMenu();
      },
    };
    const fn = actions[action];
    if (!fn) return false;
    fn();
    return true;
  };

  const configuredShortcut = window.RobotDojoShortcuts?.matchEvent?.(e);
  const canRunInInput = configuredShortcut === 'close';
  if (configuredShortcut && (!inInput || canRunInInput)) {
    e.preventDefault();
    if (runShortcutAction(configuredShortcut)) return;
  }

  // Modifier combos
  if (e.key === '?' && e.shiftKey && !inInput) { e.preventDefault(); toggleHelp(); return; }
  if (e.key === '#' && !inInput) { e.preventDefault(); const id = currentConvId; if (id) quickDelete(id); return; }

  // Model dropdown keyboard
  const dd = $('#modelDropdown.open');
  if (dd) {
    if (e.key === 'Escape' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); closeDropdown(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); return; }
    if (e.key === 'Enter') { e.preventDefault(); closeDropdown(); return; }
  }

  if (e.key === 'Escape') {
    if (inInput) { document.activeElement?.blur(); return; }
    if ($('#helpModal').classList.contains('open')) { closeHelp(); return; }
    if (sending && abortController) { abortController.abort(); return; }
    closeContextMenu(); closeDropdown(); closeModal(); closeConvDetailMenu();
    return;
  }

  if (inInput || e.metaKey || e.ctrlKey || e.altKey) return;

  // Direct actions
  const DIRECT = {
    'j': () => kbNavMove(1), 'k': () => kbNavMove(-1),
    'o': () => kbOpenHighlighted(),
    'u': () => newConversation(),
    'n': () => newConversation(),
    '@': () => newActionConversation(),
    '/': () => { const ta = $('.chat-input'); if (ta) ta.focus(); },
    'e': () => kbArchive(), 'y': () => kbArchive(),
    'r': () => { const ta = $('.chat-input'); if (ta) ta.focus(); },
    't': () => { closeDropdown(); const td = $('#topicDropdown'); if (td) td.classList.toggle('open'); },
    's': () => kbToggleStar(),
    'f': () => { const f = $('.input-toolbar input[type=file]'); if (f) f.click(); },
    'm': () => cycleModel(),
  };

  if (DIRECT[e.key]) { e.preventDefault(); DIRECT[e.key](); }
}

function kbNavMove(dir) {
  const rows = getTopicNavRows();
  if (!rows.length) return;
  const curIdx = rows.findIndex((el) => el.classList.contains('active'));
  const nextIdx = Math.max(0, Math.min(rows.length - 1, (curIdx < 0 ? 0 : curIdx) + dir));
  rows[nextIdx]?.click();
  rows[nextIdx]?.scrollIntoView({ block: 'nearest' });
}

function kbOpenHighlighted() {
  const rows = getTopicNavRows();
  const active = rows.find((el) => el.classList.contains('active')) || rows[0];
  active?.click();
}

function kbArchive() {
  if (selectedConversations.size > 0) { bulkArchive(); return; }
  const id = currentConvId;
  if (id) quickArchive(id);
}

function kbToggleStar() {
  if (selectedConversations.size > 0) { bulkStar(); return; }
  const id = currentConvId;
  if (!id) return;
  const conv = cachedConvs.find(c => c.id === id);
  if (conv) toggleStar(id, conv.pinned ? 0 : 1);
}

document.addEventListener('keydown', handleKeys);

// ─── Window Exports (for shared modules) ──────────────────────────

Object.assign(window, {
  showListView, newConversation, switchNavItem,
  loadConversation, loadConversationAndHighlight,
  openTopicLive, openTopicHistory,
  showConfirmModal, showPromptModal, closeModal, toggleHelp, closeHelp,
  openContextMenu, closeContextMenu, handleCtx,
  renderSearchResults, handleFiles, renderFileChips,
  closeConvDetailMenu,
  doSearch,
});

// ─── Init ─────────────────────────────────────────────────────────

function buildEntityContext(type, data) {
  if (type === 'company') {
    const domains = (data.domains || []).join(', ');
    const peopleList = (data.people || []).slice(0, 10).map(p => p.display_name).join(', ');
    return `The user is asking about a company in their network. Here is the structured profile:\n` +
      `Name: ${data.name}\nTier: ${data.tier || 'unknown'}\nDomains: ${domains || 'none'}\n` +
      `People count: ${data.people_count || data.people?.length || 0}\nKey people: ${peopleList || 'none'}\n\n` +
      `Give an intelligent, concise summary of this company and the user's relationship to it. ` +
      `Synthesize — don't dump data. If the user corrects something, acknowledge and note the correction.`;
  }
  const emails = (data.identifiers || []).filter(i => i.type === 'email').map(i => i.value).join(', ');
  const phones = (data.identifiers || []).filter(i => i.type === 'phone').map(i => i.value).join(', ');
  const topics = (data.topics || []).map(t => t.topic).join(', ');
  const years = data.years_known != null ? (data.years_known >= 1 ? Math.round(data.years_known) + ' years' : '<1 year') : 'unknown';
  const channels = [
    data.email_count ? `${data.email_count} emails` : '',
    data.cal_count ? `${data.cal_count} calendar events` : '',
    data.imsg_count ? `${data.imsg_count} messages` : '',
  ].filter(Boolean).join(', ');
  return `The user is asking about someone in their personal network. Here is the structured profile:\n` +
    `Name: ${data.display_name}\nTier: ${data.tier || 'unknown'}\nYears known: ${years}\n` +
    `Emails: ${emails || 'none'}\nPhones: ${phones || 'none'}\nTopics: ${topics || 'none'}\n` +
    `Interaction channels: ${channels || 'none'}\nRelationship origin: ${data.relationship_origin || 'unknown'}\n` +
    `First seen: ${data.first_seen || 'unknown'}\nLast seen: ${data.last_seen || 'unknown'}\n\n` +
    `Give an intelligent, concise summary of this person and the user's relationship. ` +
    `Highlight: how they likely met, what connects them, how active the relationship is. ` +
    `Synthesize into a narrative — don't list raw fields. If the user corrects something, acknowledge and note the correction.`;
}

function triggerPrompt(text, autosend) {
  const ta = $('.chat-input');
  const sb = $('.send-circle');
  if (!ta) return;
  ta.value = text;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  ta.focus();
  if (autosend && sb) setTimeout(() => doSend(ta, sb), 100);
}

function decodeCorrectionParam(value) {
  if (!value) return null;
  const raw = String(value);
  const tryParse = (text) => {
    try { return JSON.parse(text); } catch { return null; }
  };
  const uriParsed = tryParse(decodeURIComponent(raw));
  if (uriParsed?.mode === 'viewer_correction') return uriParsed;
  if (typeof atob === 'function') {
    try {
      const padded = raw.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (raw.length % 4)) % 4);
      const decoded = decodeURIComponent(escape(atob(padded)));
      const parsed = tryParse(decoded);
      if (parsed?.mode === 'viewer_correction') return parsed;
    } catch {
      // Ignore malformed correction payloads; chat still opens normally.
    }
  }
  return null;
}

async function initMarkdownEditMode(params) {
  if (params.get('mode') !== 'edit') return false;
  const target = params.get('target');
  if (!target) return false;
  try {
    const res = await fetch(`/api/accounts/edit-targets/${encodeURIComponent(target)}`);
    if (!res.ok) return false;
    const data = await res.json();
    window.robotdojoEditMode = { target, label: data.label, content: data.content || '' };
    const prompt = [
      `We are editing ${data.label}.`,
      'Print the current markdown below, then ask what edits the user wants.',
      'Iterate conversationally. Do not write the file on each turn.',
      'When the user says they are done, ask them to send `FINAL MARKDOWN` followed by the final markdown. The client will save that exact markdown back to the allowlisted file.',
      '',
      'Current markdown:',
      '```markdown',
      data.content || '',
      '```',
    ].join('\n');
    setTimeout(() => triggerPrompt(prompt, true), 0);
    return true;
  } catch {
    return false;
  }
}

// ─── st_8c7b7a6b D2 + D5 — chat speed hooks ───────────────────────
// Two responsibilities:
//   1. Speculative prefetch (D2): as the user types, fire `POST /api/prefetch`
//      debounced @ 300 ms once input length ≥ 10. Fire-and-forget — by the
//      time the user hits send, the cheap DB/FTS path is warm without loading
//      the local embedding model into the interactive server.
//   2. TTFT estimate (D5): on input focus, fetch `GET /api/chat/ttft-estimate`
//      and render `estimate_ms` next to the loading indicator so the user
//      knows what to expect ("~2.3s expected"). Stash on
//      `window._ttftEstimateMs` so per-turn indicator renders can pick it up.
//
// Both endpoints inherit cookie-or-Bearer auth via lib/middleware-auth.js.
// --- Chat-app-active ping (st_fd14cdd4 AC9) ---
// Tell the server the chat app is OPEN the instant it loads, then keep that state
// fresh on focus / visibility→visible and on a heartbeat while it stays open. The
// server stamps a chat-app-active recency signal the chunk-embed daemon reads to
// drop its in-flight chunk and stay paused — so the single SQLCipher writer is free
// BEFORE the user finishes typing, not only once a turn is submitted. Fire-and-
// forget; a failed ping never surfaces and just means the next heartbeat carries it.
// 30s heartbeat pairs with the server's 75s active window (≈ heartbeat × 2.5), so a
// single dropped ping does not flip the app to "closed" mid-session.
const _CHAT_APP_HEARTBEAT_MS = 30_000;
let _chatAppHeartbeat = null;
async function _pingChatAppActive() {
  try {
    await fetch('/api/chat/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: '{}',
    });
  } catch { /* fire-and-forget — never surface to user */ }
}
const _TOPIC_SESSION_IDLE_MS = 30 * 60 * 1000;
let _topicSessionIdleTimer = null;

function closeCurrentTopicSession(reason) {
  const topic = window._lockedTopicSlug;
  const conversationId = currentConvId;
  if (!topic && !conversationId) return;
  const body = JSON.stringify({ topic: topic || undefined, conversationId: conversationId || undefined, reason });
  let sent = false;
  try {
    if (navigator.sendBeacon) {
      sent = navigator.sendBeacon('/api/chat/session-close', new Blob([body], { type: 'application/json' }));
    }
  } catch { sent = false; }
  if (sent) return;
  fetch('/api/chat/session-close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    keepalive: true,
    body,
  }).catch(() => {});
}

function bumpTopicSessionIdle() {
  if (_topicSessionIdleTimer) clearTimeout(_topicSessionIdleTimer);
  _topicSessionIdleTimer = setTimeout(() => closeCurrentTopicSession('idle'), _TOPIC_SESSION_IDLE_MS);
}

function setupTopicSessionClose() {
  if (window._topicSessionCloseWired) return;
  window._topicSessionCloseWired = true;
  bumpTopicSessionIdle();
  // Close the session only when the page is actually going away, or after
  // 30 minutes idle. Switching tabs / backgrounding is not a close.
  // Desktop close: beforeunload. Mobile close: pagehide with persisted=false
  // (the document is discarded). pagehide with persisted=true is bfcache —
  // they can come back in two minutes; do not write a resume.
  window.addEventListener('beforeunload', () => closeCurrentTopicSession('tab-close'));
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    closeCurrentTopicSession('tab-close');
  });
  document.addEventListener('pointerdown', bumpTopicSessionIdle, { passive: true });
  document.addEventListener('keydown', bumpTopicSessionIdle);
  window.addEventListener('robotdojo:chat-idle', bumpTopicSessionIdle);
}

function setupChatAppActiveSignal() {
  if (window._chatAppActiveWired) return;
  window._chatAppActiveWired = true;
  // Ping immediately on load so the embedder yields before the first keystroke.
  _pingChatAppActive();
  // Refresh when the tab becomes visible / focused (returning to an open app must
  // re-quiet the embedder even if the heartbeat lapsed while the tab was hidden).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _pingChatAppActive();
  });
  window.addEventListener('focus', () => { _pingChatAppActive(); });
  // Heartbeat while the app stays open so "app open" is a sustained state. Skip the
  // ping while the tab is hidden — a backgrounded tab is not an active chat session,
  // so the window lapses and the embedder resumes its drain.
  _chatAppHeartbeat = setInterval(() => {
    if (document.visibilityState !== 'hidden') _pingChatAppActive();
  }, _CHAT_APP_HEARTBEAT_MS);
}

let _prefetchDebounce = null;
function _currentPrefetchContext() {
  // Mirror modules/chat.js labelContext priority: locked topic > selected
  // label/group > 'general'. Cheap heuristic — wrong context just means the
  // prefetch warms a slightly different cache slot; never wrong-data.
  if (window._lockedTopicSlug) return window._lockedTopicSlug;
  const activeGroup = document.querySelector('.label-item.active, .group-parent.active');
  const slug = activeGroup?.dataset?.context;
  return (slug && slug !== 'all') ? slug : 'general';
}
async function _firePrefetch(query) {
  if (!query || query.length < 10) return;
  try {
    await fetch('/api/prefetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ query, context: _currentPrefetchContext() }),
    });
  } catch { /* fire-and-forget — never surface to user */ }
}
function _renderTTFTEstimate(estimate_ms) {
  if (typeof estimate_ms !== 'number' || !Number.isFinite(estimate_ms)) return;
  window._ttftEstimateMs = estimate_ms;
  // If an indicator is currently visible, append "~Ns expected" without
  // stomping the phase label. The element is appended/recreated by
  // modules/chat.js per turn — we render best-effort.
  const indicator = document.querySelector('.chat-indicator');
  if (!indicator) return;
  if (indicator.dataset?.slaManaged === 'true') return;
  const seconds = Math.max(0.1, Math.round(estimate_ms / 100) / 10);
  let est = indicator.querySelector('.ttft-estimate');
  if (!est) {
    est = document.createElement('span');
    est.className = 'ttft-estimate';
    est.style.cssText = 'margin-left:0.5em;opacity:0.55;font-size:0.85em';
    indicator.appendChild(est);
  }
  est.textContent = `~${seconds}s expected`;
}
async function _fetchTTFTEstimate() {
  try {
    // No `?model=` query — server defaults to the fast chat model. Future
    // per-model UI can pass the selected key from state.js explicitly.
    const res = await fetch('/api/chat/ttft-estimate', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) return;
    const body = await res.json();
    if (body && typeof body.estimate_ms === 'number') _renderTTFTEstimate(body.estimate_ms);
  } catch { /* network noise — never break UI */ }
}
function setupChatSpeedHooks() {
  // The .chat-input element exists after bindInputEvents in modules/input.js
  // wires the composer. Poll briefly until it appears.
  const wire = () => {
    const ta = document.querySelector('.chat-input');
    if (!ta) return false;
    if (ta._chatSpeedWired) return true;
    ta._chatSpeedWired = true;
    // D2 — debounced (300 ms) input → /api/prefetch once length ≥ 10.
    ta.addEventListener('input', () => {
      if (_prefetchDebounce) clearTimeout(_prefetchDebounce);
      _prefetchDebounce = setTimeout(() => {
        const val = ta.value || '';
        if (val.trim().length >= 10) _firePrefetch(val.trim());
      }, 300);
    });
    // D5 — on focus → refresh TTFT estimate. The endpoint is cheap and the
    // estimate moves slowly, so refreshing per focus is fine.
    ta.addEventListener('focus', () => { _fetchTTFTEstimate(); });
    // Also fetch once at wire-time so window._ttftEstimateMs is populated
    // before the user's first interaction.
    _fetchTTFTEstimate();
    return true;
  };
  if (!wire()) {
    let tries = 0;
    const iv = setInterval(() => { if (wire() || ++tries > 20) clearInterval(iv); }, 150);
  }
}

// --- Post-entitlement upgrade race handler ---
// Legacy paid flows and private beta key issuance both land asynchronously.
// If a return URL carries ?pay=done from an older checkout path, wait until the
// entitlement has reached the local runtime before rendering chat.
async function awaitBeltUpgrade({ max = 20, intervalMs = 500 } = {}) {
  for (let i = 0; i < max; i++) {
    try {
      const res = await fetch('/api/whoami', { credentials: 'same-origin', cache: 'no-store' });
      if (res.ok) {
        const body = await res.json();
        if (body?.belt === 'black') return true;
      }
    } catch { /* network blip — try again */ }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}

function showUpgradeFinalizing() {
  // Minimal blocking overlay — no framework, matches app-ready toggle pattern.
  const overlay = document.createElement('div');
  overlay.id = 'upgradeFinalizing';
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.style.cssText = [
    'position:fixed','inset:0','z-index:9999',
    'display:flex','flex-direction:column','align-items:center','justify-content:center',
    'gap:1rem','background:rgba(250,252,255,0.96)','backdrop-filter:blur(4px)',
    'font-family:Inter,system-ui,sans-serif','color:#0f172a','text-align:center','padding:2rem',
  ].join(';');
  overlay.innerHTML = `
    <div style="width:32px;height:32px;border:3px solid #e2e8f0;border-top-color:#3b82f6;border-radius:50%;animation:rdSpin 0.9s linear infinite"></div>
    <div style="font-size:1.05rem;font-weight:550;letter-spacing:-0.01em">Finalizing Black Belt access…</div>
    <div id="upgradeFinalizingSub" style="font-size:0.85rem;color:#64748b;max-width:420px">
      Provisioning Black Belt modules. This usually takes a few seconds.
    </div>
    <style>@keyframes rdSpin{to{transform:rotate(360deg)}}</style>`;
  document.body.appendChild(overlay);
  return overlay;
}

async function handleStripeReturn() {
  const params = new URLSearchParams(location.search);
  if (params.get('pay') !== 'done') return false;

  const overlay = showUpgradeFinalizing();
  const ok = await awaitBeltUpgrade({ max: 20, intervalMs: 500 });
  if (!ok) {
    const sub = overlay.querySelector('#upgradeFinalizingSub');
    if (sub) {
      sub.innerHTML = 'Access is still provisioning. Refresh in a moment.';
      sub.style.color = '#b91c1c';
    }
    return true; // block init; user will refresh manually
  }

  // Clear the flag and reload so shell.js re-fetches belt + rebuilds waffle/tools.
  params.delete('pay');
  const q = params.toString();
  const nextUrl = location.pathname + (q ? `?${q}` : '') + location.hash;
  location.replace(nextUrl);
  return true;
}

function initialConversationRequest(params) {
  if (params.get('mode') === 'edit') return null;
  const topicMatch = location.pathname.match(/\/chat\/topic\/([^/?#]+)/);
  if (topicMatch) return null;
  const historyMatch = location.pathname.match(/\/chat\/history\/([^/?#]+)/);
  if (historyMatch) return null;
  const pathConvIdRaw = location.pathname.match(/\/chat\/([^/?#]+)/)?.[1];
  const pathConvId = pathConvIdRaw === 'workbench-smoke' || pathConvIdRaw === 'topic' || pathConvIdRaw === 'history'
    ? null
    : pathConvIdRaw;
  const qsConvId = params.get('id'); // always a full UUID when present
  const rawSavedView = localStorage.getItem('layout-view') || 'focus';
  const normalized = typeof window.normalizeChatViewForViewport === 'function'
    ? window.normalizeChatViewForViewport(rawSavedView)
    : rawSavedView;
  const savedView = (normalized === 'split' || normalized === 'dual' || normalized === 'list')
    ? 'focus'
    : normalized;

  if (qsConvId) {
    return {
      savedView,
      fallbackId: qsConvId,
      promise: fetch('/api/conversations/' + encodeURIComponent(qsConvId), { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : null),
    };
  }

  if (!pathConvId) return null;
  const pathParts = pathConvId.split('-');
  const lastToken = pathParts[pathParts.length - 1];
  const isShortId = /^[0-9a-f]{8}$/i.test(lastToken);
  const isFullUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pathConvId);

  if (isShortId && !isFullUuid) {
    return {
      savedView,
      promise: fetch('/api/conversations/resolve/' + lastToken, { credentials: 'same-origin' })
        .then(r => r.ok ? r.json() : null),
    };
  }

  return {
    savedView,
    fallbackId: pathConvId,
    promise: fetch('/api/conversations/' + encodeURIComponent(pathConvId), { credentials: 'same-origin' })
      .then(r => r.ok ? r.json() : null),
  };
}

async function init() {
  // If we just returned from a legacy paid flow, wait for entitlement before
  // rendering so chat does not boot with a stale White Belt tool schema.
  if (await handleStripeReturn()) return;
  const params = new URLSearchParams(location.search);
  const profileImportMode = params.get('profile_import') === '1';
  window.robotdojoProfileImportMode = profileImportMode;
  const initialConversation = initialConversationRequest(params);
  const topicMatch = location.pathname.match(/\/chat\/topic\/([^/?#]+)/);
  const historyMatch = location.pathname.match(/\/chat\/history\/([^/?#]+)/);
  setLoadStatus('Opening chat...');

  // st_5a63545d AC 20b — cohort stale-banner. Fetched on init so the user
  // sees the "your dojo is N days behind" message the first paint when
  // entitlement has lapsed. Failure mode: silent — banner stays hidden.
  fetch('/api/server-health')
    .then((r) => r.ok ? r.json() : null)
    .then((h) => {
      if (h && h.bb_active === false) {
        const banner = document.createElement('div');
        banner.className = 'bb-stale-banner';
        banner.setAttribute('data-card', 'bb-stale-banner');
        banner.style.cssText = 'background:#fef3c7;border:1px solid #fcd34d;color:#78350f;padding:0.75rem 1rem;border-radius:8px;margin:0.75rem;font-size:0.92rem';
        const days = Number.isFinite(h.bb_days_behind) && h.bb_days_behind > 0 ? h.bb_days_behind : '—';
        banner.textContent = `Your dojo is ${days} days behind — reactivate to resume memory.`;
        // Insert at the top of the chat container so it's visible above the message list.
        const target = document.querySelector('.chat-main') || document.body;
        target.insertBefore(banner, target.firstChild);
      }
    })
    .catch(() => { /* silent */ });

  initShell();
  // Reveal the styled chat shell before authenticated data finishes.
  // Slow model/label calls should not keep the route visually blank.
  markAppReady();
  setLoadStatus('Loading topics and models...');
  // st_fd14cdd4 AC9 — tell the server the chat app is open the instant it loads
  // (not on submit) so the chunk-embed daemon drops its in-flight chunk and yields
  // the writer before the user finishes typing. Independent of the composer wiring.
  setupChatAppActiveSignal();
  setupTopicSessionClose();
  const topicStore = initTopicStore({
    setLabels,
    setInboxCount,
    onChange: () => renderLabels(),
  });
  applyWarmChatBootData();
  topicStore.hydrate();
  renderLabels();
  topicStore.bindLiveRefresh();
  const fastNewChatPaint = !initialConversation && !profileImportMode && !topicMatch && !historyMatch;
  if (fastNewChatPaint) {
    updateGreeting();
    newConversation();
  }
  const topicsP = topicStore.refresh();
  const [modelsRes, prefsRes] = await Promise.all([
    fetch('/api/models', { credentials: 'same-origin', cache: 'no-store' }),
    fetch('/api/preferences', { credentials: 'same-origin', cache: 'no-store' }),
  ]);
  await topicsP;
  if (modelsRes.status === 401) { clearLoadStatus(); markAppReady(); showLogin(); return; }
  if (modelsRes.ok) {
    const modelsData = await modelsRes.json();
    writeWarmPayload('rd_warm_models', modelsData);
    setModels(modelsData);
    if (modelsData.length) {
      const next = modelsData.find((m) => m.isDefault)?.key
        || modelsData.find((m) => m.key === 'grok-4.3')?.key
        || (modelsData.some((m) => m.key === selectedModel) ? selectedModel : null)
        || modelsData[0]?.key;
      if (next) setSelectedModel(next);
    }
    setThinkingLevel(models.find(m => m.key === selectedModel)?.tier === 0 ? 'high' : 'medium');
  } else {
    showToast('Could not load models. Retry in a moment.');
  }
  if (prefsRes.ok) {
    try {
      const prefsData = await prefsRes.json();
      writeWarmPayload('rd_warm_preferences', prefsData);
      if (prefsData?.agent_name) setAgentName(prefsData.agent_name);
    } catch {}
  }
  try {
    const emptyPrompt = document.getElementById('emptyPrompt');
    if (emptyPrompt?.querySelector('.chat-input')) {
      emptyPrompt.innerHTML = buildInputBox();
      bindInputEvents('emptyPrompt');
    }
    const inputArea = document.getElementById('inputArea');
    if (inputArea?.querySelector('.chat-input')) {
      inputArea.innerHTML = buildInputBox();
      bindInputEvents('inputArea');
    }
  } catch (err) {
    console.warn('[chat] composer rebuild skipped', err);
  }
  setLoadStatus('Preparing workspace...');
  updateGreeting();
  updateUsage();
  Promise.resolve(window._beltReady).catch(() => {}).finally(() => renderLabels());

  await initMarkdownEditMode(params);
  const correction = decodeCorrectionParam(params.get('correction'));
  if (correction) {
    window.RobotDojoCorrectionTarget = correction;
    setUrlContext(JSON.stringify(correction));
  }
  // st_d9fc573b AC 10 — Assistant tab's Edit button links to /chat?prefill=...
  // and the textarea is pre-filled (no autosend). Defer until composer renders.
  const prefill = params.get('prefill');
  if (prefill) setTimeout(() => { const ta = document.querySelector('.chat-input'); if (ta) { ta.value = prefill; ta.dispatchEvent(new Event('input', { bubbles: true })); } }, 0);
  // Determine the conversation to load:
  //   1. ?id= query param — full UUID.
  //   2. Path slug-shortId — short ID resolved through the chat API.
  //   3. Path full UUID (legacy bookmark).
  //   4. No ID — open new conversation.
  if (topicMatch) {
    const slug = decodeURIComponent(topicMatch[1]);
    setLoadStatus('Opening conversation...');
    openTopicLive(slug);
  } else if (historyMatch) {
    const slug = decodeURIComponent(historyMatch[1]);
    setLoadStatus('Opening conversation...');
    openTopicHistory(slug);
  } else if (initialConversation) {
    setLoadStatus('Opening conversation...');
    $('#mainArea').dataset.view = initialConversation.savedView;
    initialConversation.promise
      .then(data => {
        if (data?.id) loadConversation(data.id, { preloaded: data });
        else if (initialConversation.fallbackId) loadConversation(initialConversation.fallbackId);
        else newConversation();
      })
      .catch(() => {
        if (initialConversation.fallbackId) loadConversation(initialConversation.fallbackId);
        else newConversation();
      });
  } else {
    setLoadStatus('Starting a new chat...');
    if (profileImportMode) newActionConversation();
    else if (!fastNewChatPaint) newConversation();
    else clearLoadStatus();
    // URL-driven prompt: ?prompt=...&context=...&autosend=true
    const prompt = params.get('prompt');
    const context = params.get('context');
    const autosend = params.get('autosend') === 'true';
    const entityType = params.get('entity_type');
    const entityId = params.get('entity_id');
    if (entityType && entityId) {
      // Entity context chat — fetch profile and build intelligent context
      const endpoint = entityType === 'company' ? `/api/network/companies/${entityId}` : `/api/network/people/${entityId}`;
      fetch(endpoint).then(r => r.ok ? r.json() : null).then(data => {
        if (data) setUrlContext(buildEntityContext(entityType, data));
        if (prompt) triggerPrompt(prompt, autosend);
      }).catch(() => { if (prompt) triggerPrompt(prompt, autosend); });
    } else if (context) {
      // Load generated setup context JSON and store for next send. Chat MUST
      // init normally no matter what this fetch does (st_96bb626f AC 11): a
      // missing file (!r.ok), a network/fetch error, or a corrupt body (bad
      // JSON / hash mismatch) all degrade to a normal greeting with the input
      // active — never a blank screen. Every failure is logged server-side
      // only via logContextFailure; the chat proceeds regardless.
      fetch(`/static/faq/${context}.json`)
        .then(r => {
          if (!r.ok) { logContextFailure('http_error', `${context}:${r.status}`); return null; }
          // A truncated / corrupt / hash-mismatched body fails JSON parse —
          // swallow it, log, and continue with no context rather than throwing.
          return r.json().catch(err => { logContextFailure('parse_error', `${context}:${(err && err.message) || 'invalid json'}`); return null; });
        })
        .then(data => {
          if (data) setUrlContext(typeof data === 'string' ? data : JSON.stringify(data));
          if (prompt) triggerPrompt(prompt, autosend);
        })
        .catch(err => {
          logContextFailure('fetch_error', `${context}:${(err && err.message) || 'network error'}`);
          if (prompt) triggerPrompt(prompt, autosend);
        });
    } else if (prompt) {
      triggerPrompt(prompt, autosend);
    }
  }
  markAppReady();
  setInterval(updateUsage, 30000);

  // st_8c7b7a6b — wire speculative prefetch (D2) + TTFT estimate (D5).
  setupChatSpeedHooks();

  // ─── Drop-folder + secure_input wiring ──────────────────────────
  // Both components listen on the global chat event bus. Events arrive
  // either via the active chat stream (see modules/chat.js handleSSEEvent)
  // or via the ambient EventSource opened below.
  const dropEvents = createDropEventsRenderer({
    container: $('#messagesInner'),
    scroller: $('#messages'),
    isStreaming: () => !!sending,
  });
  window.__chatEventBus.on('file_arrived',    dropEvents.handleEvent);
  window.__chatEventBus.on('file_classified', dropEvents.handleEvent);
  window.__chatEventBus.on('file_processed',  dropEvents.handleEvent);
  window.__chatEventBus.on('file_errored',    dropEvents.handleEvent);

  const secureInput = createSecureInputController({
    host: $('#inputArea'),
    onOpen: () => {
      // Disable the main chat input while a credential request is pending.
      const ta = $('.chat-input'); if (ta) ta.disabled = true;
      const sb = $('.send-circle'); if (sb) sb.disabled = true;
      document.body.classList.add('secure-input-active');
    },
    onClose: () => {
      const ta = $('.chat-input'); if (ta) { ta.disabled = false; ta.focus(); }
      const sb = $('.send-circle'); if (sb) sb.disabled = !ta?.value.trim();
      document.body.classList.remove('secure-input-active');
    },
  });
  window.__chatEventBus.on('secure_input', (e) => secureInput.present(e));
  window._secureInput = secureInput; // test hook

  // Ambient stream — optional. If the backend exposes /api/chat/events as
  // a persistent SSE feed, we subscribe so file_* events arrive even when
  // no chat request is in flight. If the endpoint is missing, fail silently.
  try {
    const apexRelay = location.hostname === 'robotdojo.ai';
    if (!apexRelay) {
      const token = localStorage.getItem('robotdojo_token');
      const url = token ? `/api/chat/events?token=${encodeURIComponent(token)}` : '/api/chat/events';
      const es = new EventSource(url);
      es.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          window.__chatEventBus.dispatch(d);
        } catch { /* malformed line, ignore */ }
      };
      // If the endpoint returns 404 repeatedly, browsers will keep retrying.
      // Bail after the first error to avoid console noise.
      es.onerror = () => {
        es.close();
      };
      window._ambientStream = es;
    }
  } catch { /* no-op */ }

  document.addEventListener('click', e => {
    if (!e.target.closest('.pill-wrapper,.pill-dropdown')) closeDropdown();
    if (!e.target.closest('.context-menu,.menu-dots,.label-item')) closeContextMenu();
    if (!e.target.closest('.waffle-menu') && typeof closeWaffleMenu === 'function') closeWaffleMenu();
    if (!e.target.closest('.conv-detail-menu-wrapper')) closeConvDetailMenu();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadConversations(); updateUsage(); } });

  if (isMobile()) {
    document.addEventListener('touchstart', e => { setTouchStartX(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) < 60) return;
      if (dx > 0 && touchStartX < 40) toggleSidebar(true);
      if (dx < 0 && !$('#sidebar').classList.contains('hidden') && !$('#sidebar').classList.contains('collapsed')) toggleSidebar(false);
    }, { passive: true });
  }
}

if (location.pathname === '/ask') {
  import('./public-app.js').then(({ initPublicChat }) => initPublicChat());
} else {
  init();
}
