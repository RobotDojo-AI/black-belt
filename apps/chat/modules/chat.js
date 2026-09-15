// Chat — conversations, messages, labels, modals, streaming, pipeline
import {
  currentConvId, messages, models, selectedModel, selectedLabel,
  conversationMode, savedSessionModel, cachedConvs, labels,
  attachedFiles, sending, abortController, thinkingLevel, chatMode,
  conversationCostCents, selectedConversations, collapsedGroups,
  modalCallback, inboxCount, urlContext,
  cachedActionConvs, pendingActionChat, agentName,
  setCachedConvs, setCurrentConvId, setMessages, setSelectedModel,
  setSavedSessionModel, setAttachedFiles, setHighlightedConvIdx,
  setConversationCostCents, setSending, setAbortController,
  setLabels, setSelectedLabel, setInboxCount, setCollapsedGroups,
  setModalCallback, addConversationCost, setUrlContext,
  setCachedActionConvs, setPendingActionChat,
} from './state.js';
// Decomposed client modules (st_74f45a1a Phase 3/4).
import { Indicator } from './indicator.js?v=2026-09-07-you-11';
import { ErrorUI } from './error-ui.js';
import { streamChatTurn } from './stream-client.js?v=2026-09-09-3';
import { resolveNavGroups, shouldFlattenTopicNav, buildTopicNavModel, isShown } from './topic-nav.js';
import { getTopicStore } from './topic-store.js?v=2026-09-08-9';

const CLIENT_PRELUDE_MS = 900;
const CLIENT_PRELUDE_TEXT = 'Thinking it through.';

const MATERIAL_ICON_ALIASES = {
  'activity': 'monitoring',
  'award': 'military_tech',
  'book': 'menu_book',
  'briefcase': 'work',
  'building': 'business',
  'cpu': 'memory',
  'dollar-sign': 'attach_money',
  'graduation-cap': 'school',
  'heart': 'favorite',
  'rss': 'rss_feed',
  'trending-down': 'trending_down',
  'trending-up': 'trending_up',
  'user': 'person',
  'user-activity': 'monitoring',
  'zap': 'bolt',
};

function materialIconName(icon, fallback = 'label') {
  const raw = String(icon || '').trim().toLowerCase();
  if (!raw) return fallback;
  const normalized = raw.replace(/\s+/g, '-');
  return MATERIAL_ICON_ALIASES[normalized] || normalized.replace(/-/g, '_');
}

function setLoadStatus(message) {
  window.RobotDojoLoadStatus?.set?.(message);
}

function clearLoadStatus() {
  window.RobotDojoLoadStatus?.clear?.();
}

// ─── View Management ──────────────────────────────────────────────

function setView(view) {
  // Threads are backend. Chat never paints a conversation list.
  if (view === 'split' || view === 'dual' || view === 'list') view = 'focus';
  const mainArea = $('#mainArea');
  if (mainArea) mainArea.dataset.view = view;
  document.body.classList.toggle('view-new-chat', view === 'new-chat');
  if (view !== 'new-chat') localStorage.setItem('layout-view', view);
  mainArea?.querySelectorAll(':scope > .gutter').forEach(g => g.remove());
  ['#convListView', '#chatView'].forEach(sel => {
    const el = mainArea?.querySelector(sel);
    if (el) { el.style.width = ''; el.style.flex = ''; el.style.flexBasis = ''; }
  });
}

// ─── URL Base — simple /chat path ────────────────────────────────
//
// Chat deep-link URLs always use /chat (or /chat/<id>).
// The 4-segment /<servername>/<handle>/chat form is not in the Vercel
// middleware matcher and caused redirect loops on page refresh.

/**
 * Return the base path for chat deep links — always '/chat'.
 */
export function chatBasePath() {
  return '/chat';
}

function liveTopicPath(slug) {
  const raw = String(slug || '').trim();
  if (!raw) return null;
  const colon = raw.indexOf(':');
  if (colon > 0) {
    const kind = raw.slice(0, colon).toLowerCase();
    const id = raw.slice(colon + 1);
    if (id && (kind === 'person' || kind === 'company' || kind === 'place')) {
      return chatBasePath() + '/' + encodeURIComponent(kind) + '/' + encodeURIComponent(id);
    }
  }
  return '/chat/topic/' + encodeURIComponent(raw);
}

function replaceConversationUrl(conv) {
  const liveSlug = conv && Number(conv.is_live) === 1
    ? (conv.topic_slug || window._lockedTopicSlug)
    : null;
  if (liveSlug) {
    const path = liveTopicPath(liveSlug);
    if (path) {
      history.replaceState(null, '', path);
      return;
    }
  }
  if (conv?.id) {
    history.replaceState(null, '', chatBasePath() + '/' + buildChatSlug(conv));
    return;
  }
  history.replaceState(null, '', chatBasePath());
}

// ─── Conversations ────────────────────────────────────────────────

export function defaultSelectableModel() {
  return models.find((model) => model.isDefault)?.key
    || (models.some((model) => model.key === DEFAULT_MODEL) ? DEFAULT_MODEL : null)
    || models[0]?.key
    || DEFAULT_MODEL;
}

function readChatWarmPayload(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.payload ?? null;
  } catch {
    return null;
  }
}

function writeChatWarmPayload(key, payload) {
  try { localStorage.setItem(key, JSON.stringify({ payload, ts: Date.now() })); } catch { /* */ }
}

export async function loadConversations() {
  const isActions = selectedLabel === 'actions';
  const url = isActions ? '/api/conversations?type=action&all=1' : '/api/conversations?all=1';
  const cacheKey = isActions ? 'rd_chat_action_conversations' : 'rd_chat_conversations';
  const cached = readChatWarmPayload(cacheKey);
  if (cached) {
    if (isActions) setCachedActionConvs(cached);
    else setCachedConvs(cached);
    if ($('#mainArea')?.dataset.view === 'split') renderConvListView();
    fetchJSON(url).then((fresh) => {
      if (!fresh) return;
      writeChatWarmPayload(cacheKey, fresh);
      if (isActions) setCachedActionConvs(fresh);
      else setCachedConvs(fresh);
      if ($('#mainArea')?.dataset.view === 'split') renderConvListView();
    }).catch(() => {});
    return;
  }
  if (selectedLabel === 'actions') {
    const data = await fetchJSON(url);
    if (!data) return;
    writeChatWarmPayload(cacheKey, data);
    setCachedActionConvs(data);
  } else {
    const data = await fetchJSON(url);
    if (!data) return;
    writeChatWarmPayload(cacheKey, data);
    setCachedConvs(data);
  }
  if ($('#mainArea')?.dataset.view === 'split') renderConvListView();
}

// st_6360589a: topic_slug is the authoritative source for which topic a
// conversation belongs to (set at INSERT via upsertConversation, mirrored
// into the conversation_topics junction for RAG scoping). The `tags` JSON
// column is the legacy field used for nav display; for conversations
// created before topic_slug existed it remains the only signal. So the
// filter checks topic_slug first and falls back to tags only when
// topic_slug is null — this prevents drift between the two storage paths
// (the "Topics picker writes tags but not topic_slug" bug we just fixed).
function slugForSelectedLabel() {
  if (typeof selectedLabel !== 'string') return null;
  return labels?.find(l => l.name === selectedLabel)?.slug
      || labels?.find(l => l.name === selectedLabel)?.context
      || null;
}

function slugsForSelectedGroup() {
  if (typeof selectedLabel !== 'object' || !selectedLabel?.names) return null;
  const nameSet = new Set(selectedLabel.names);
  return (labels || [])
    .filter(l => nameSet.has(l.name))
    .map(l => l.slug || l.context)
    .filter(Boolean);
}

export function filterConversations() {
  if (selectedLabel === 'actions') return cachedActionConvs.filter(c => !c.archived);
  const nonArchived = cachedConvs.filter(c => !c.archived && c.chat_type !== 'action');
  if (selectedLabel === 'all') return nonArchived;
  if (selectedLabel === 'starred') return nonArchived.filter(c => c.pinned);
  if (selectedLabel === null) return nonArchived;
  if (typeof selectedLabel === 'object' && selectedLabel.names) {
    const groupSlugs = slugsForSelectedGroup();
    const groupNames = selectedLabel.names;
    return nonArchived.filter(c => c.topic_slug
      ? groupSlugs?.includes(c.topic_slug)
      : c.tags?.some(t => groupNames.includes(t)));
  }
  const slug = slugForSelectedLabel();
  return nonArchived.filter(c => c.topic_slug
    ? c.topic_slug === slug
    : c.tags?.includes(selectedLabel));
}

function getListTitle() {
  if (selectedLabel === 'all' || selectedLabel === null) return 'All';
  if (selectedLabel === 'starred') return 'Starred';
  if (selectedLabel === 'actions') return 'Actions';
  if (typeof selectedLabel === 'object') {
    const tg = window._topicGroups?.find(g => g.slug === selectedLabel.group);
    return tg?.name || 'Group';
  }
  return selectedLabel;
}

export function updateBulkBar() {
  const bar = $('#bulkActionBar');
  if (!bar) return;
  const count = selectedConversations.size;
  if (count > 0) {
    bar.classList.add('visible');
    const countEl = bar.querySelector('.bulk-count');
    if (countEl) countEl.textContent = count + ' selected';
    const selectAllCb = bar.querySelector('.bulk-select-all');
    if (selectAllCb) {
      const filtered = filterConversations();
      selectAllCb.checked = count >= filtered.length && filtered.length > 0;
      selectAllCb.indeterminate = count > 0 && count < filtered.length;
    }
  } else {
    bar.classList.remove('visible');
    const countEl = bar.querySelector('.bulk-count');
    if (countEl) countEl.textContent = '';
    const selectAllCb = bar.querySelector('.bulk-select-all');
    if (selectAllCb) { selectAllCb.checked = false; selectAllCb.indeterminate = false; }
  }
  bar.querySelectorAll('.bulk-btn').forEach(b => { b.style.opacity = count > 0 ? '1' : '0.3'; b.disabled = count === 0; });
}

export function toggleSelectAll() {
  const filtered = filterConversations();
  const allSelected = filtered.length > 0 && filtered.every(c => selectedConversations.has(c.id));
  if (allSelected) {
    selectedConversations.clear();
    $$('.conv-list-row.selected').forEach(el => { el.classList.remove('selected'); const cb = el.querySelector('.conv-checkbox'); if (cb) cb.checked = false; });
  } else {
    filtered.forEach(c => selectedConversations.add(c.id));
    $$('.conv-list-row').forEach(el => { el.classList.add('selected'); const cb = el.querySelector('.conv-checkbox'); if (cb) cb.checked = true; });
  }
  updateBulkBar();
}

export async function bulkArchive() {
  const ids = Array.from(selectedConversations);
  if (!ids.length) return;
  for (const id of ids) await fetchJSON('/api/conversations/' + id + '/archive', { method: 'POST' });
  selectedConversations.clear(); updateBulkBar();
  showToast('Archived ' + ids.length + ' conversations'); loadConversations();
}

export async function bulkStar() {
  const ids = Array.from(selectedConversations);
  if (!ids.length) return;
  for (const id of ids) {
    const conv = cachedConvs.find(c => c.id === id);
    if (conv) await fetch('/api/conversations/' + id + '/pin', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: conv.pinned ? 0 : 1 }) });
  }
  selectedConversations.clear(); updateBulkBar();
  showToast('Toggled star on ' + ids.length + ' conversations'); loadConversations();
}

export function bulkDelete() {
  const ids = Array.from(selectedConversations);
  if (!ids.length) return;
  showConfirmModal('Delete', `Permanently delete ${ids.length} conversation${ids.length > 1 ? 's' : ''}?`, 'Delete', true, async () => {
    for (const id of ids) await fetchJSON('/api/conversations/' + id, { method: 'DELETE' });
    selectedConversations.clear(); updateBulkBar();
    showToast('Deleted ' + ids.length + ' conversations'); loadConversations();
  });
}

export function renderConvListView() {
  const body = $('#convListBody');
  if (!body) return;
  body.innerHTML = '';
  let bar = $('#bulkActionBar');
  if (!bar) {
    bar = document.createElement('div'); bar.className = 'bulk-action-bar'; bar.id = 'bulkActionBar';
    bar.innerHTML = `<input type="checkbox" class="bulk-select-all" data-action="toggleSelectAll" title="Select all"><span class="bulk-count">0 selected</span><button class="bulk-btn" data-action="bulkArchive" title="Archive"><span class="material-symbols-outlined icon-sm">archive</span></button><button class="bulk-btn" data-action="bulkStar" title="Star"><span class="material-symbols-outlined icon-sm">star</span></button><button class="bulk-btn" data-action="bulkDelete" title="Delete"><span class="material-symbols-outlined icon-sm">delete</span></button>`;
    body.parentNode.insertBefore(bar, body);
  }
  updateBulkBar();
  const filtered = filterConversations();
  if (!filtered.length) {
    body.innerHTML = window.RobotDojoComponents?.emptyState
      ? window.RobotDojoComponents.emptyState({ icon: 'forum', title: 'No conversations in this topic', className: 'conv-list-empty' })
      : '<div class="conv-list-empty">No conversations in this topic</div>';
    return;
  }
  const showTags = selectedLabel === 'all' || selectedLabel === 'starred' || selectedLabel === null || typeof selectedLabel === 'object';
  filtered.forEach(c => {
    const row = document.createElement('div');
    const isSelected = selectedConversations.has(c.id);
    const isAction = c.chat_type === 'action';
    row.className = 'conv-list-row' + (c.id === currentConvId ? ' active' : '') + (isSelected ? ' selected' : '') + (isAction ? ' action-chat' : '');
    row.draggable = true; row._convId = c.id;
    const starIcon = c.pinned ? 'star' : 'star_border';
    const starClass = c.pinned ? 'star-icon starred' : 'star-icon';
    const cleanTags = (c.tags || []).filter(t => t && !t.startsWith('import-') && !t.startsWith('project:') && !t.startsWith('topic:') && !/^[0-9a-f]{8}-/.test(t));
    const tagChips = cleanTags.length && showTags ? cleanTags.map(t => `<span class="conv-tag-chip">${esc(t)}</span>`).join('') : '';
    const dateStr = formatConvDate(c.updated_at);
    // For action chats, prefer action_summary as subtitle; otherwise use snippet
    const snippet = isAction && c.action_summary ? c.action_summary : (c.snippet || c.last_message || '');
    // Build action status badge
    let actionBadge = '';
    if (isAction) {
      const status = c.action_status;
      if (!status || status === 'pending') {
        actionBadge = `<span class="action-status-badge pending" title="Pending">&#x23F3;</span>`;
      } else if (status === 'running') {
        actionBadge = `<span class="action-status-badge running" title="Running"><span class="action-spinner"></span></span>`;
      } else if (status === 'completed') {
        actionBadge = `<span class="action-status-badge completed" title="Completed">&#x2713;</span>`;
      } else if (status === 'failed') {
        actionBadge = `<span class="action-status-badge failed" title="Failed">&#x2717;</span>`;
      }
    }
    row.innerHTML = `<input type="checkbox" class="conv-checkbox"${isSelected ? ' checked' : ''} data-action="toggleConvSelect" data-id="${c.id}" data-stop="true"><span class="${starClass}" data-action="toggleStar" data-id="${c.id}" data-pinned="${c.pinned ? 0 : 1}" data-stop="true"><span class="material-symbols-outlined">${starIcon}</span></span><div class="conv-row-body"><span class="conv-row-title">${esc(c.title)}</span><span class="conv-row-snippet">${esc(snippet).slice(0, 100)}</span></div><span class="conv-row-meta">${actionBadge}<span class="conv-row-chips">${tagChips}</span><span class="conv-row-date">${dateStr}</span></span><span class="conv-row-actions"><button class="conv-action-btn" data-action="quickArchive" data-id="${c.id}" data-stop="true" title="Archive">${I.archive}</button><button class="conv-action-btn conv-action-delete" data-action="quickDelete" data-id="${c.id}" data-stop="true" title="Delete">${I.trash}</button><button class="menu-dots" data-action="openContextMenu" data-id="${c.id}" data-pinned="${!!c.pinned}">${I.more}</button></span>`;
    row.onclick = () => loadConversation(c.id);
    row.oncontextmenu = (e) => openContextMenu(e, c.id, !!c.pinned);
    body.appendChild(row);
  });
}

function formatConvDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr), now = new Date();
  const today = now.toISOString().split('T')[0], convDate = d.toISOString().split('T')[0];
  if (convDate === today) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (convDate === yesterday.toISOString().split('T')[0]) return 'Yesterday';
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Build the slug-based URL segment for a conversation.
 * Format: {title-slug}-{8-hex-shortId}
 * Mirrors the lib/content-queries.js buildConversationUrl logic.
 * @param {{ id: string, title?: string }} conv
 * @returns {string}
 */
function buildChatSlug(conv) {
  const title = (conv.title || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/, '').slice(0, 50);
  const shortId = (conv.id || '').replace(/-/g, '').slice(0, 8);
  return title ? title + '-' + shortId : shortId;
}

function conversationById(id) {
  return cachedConvs.find(c => c.id === id) || cachedActionConvs.find(c => c.id === id) || null;
}

function applyConversationTitle(id, title) {
  const now = new Date().toISOString();
  const update = (rows) => rows.map(c => c.id === id ? { ...c, title, updated_at: now } : c);
  const nextConvs = update(cachedConvs);
  const nextActionConvs = update(cachedActionConvs);
  setCachedConvs(nextConvs);
  setCachedActionConvs(nextActionConvs);
  writeChatWarmPayload('rd_chat_conversations', nextConvs);
  writeChatWarmPayload('rd_chat_action_conversations', nextActionConvs);
  if (currentConvId === id) {
    const titleEl = $('#topbarTitle');
    if (titleEl) titleEl.textContent = title;
    replaceConversationUrl(conversationById(id) || { id, title });
  }
  if ($('#mainArea')?.dataset.view === 'split') renderConvListView();
}

async function renameConversation(id, title) {
  const result = await fetchJSON('/api/conversations/' + id + '/title', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  if (!result?.ok) {
    showToast('Rename failed');
    return false;
  }
  applyConversationTitle(id, result.title || title);
  loadConversations();
  return true;
}

export async function loadConversation(id, { preloaded = null } = {}) {
  if (id !== currentConvId) {
    setLoadStatus('Opening conversation...');
    const inner = $('#messagesInner');
    if (inner) inner.innerHTML = '';
    setCurrentConvId(id); setMessages([]);
  }
  if (preloaded) setLoadStatus('Rendering conversation...');
  const conv = preloaded || await fetchJSON('/api/conversations/' + id);
  if (!conv) { history.replaceState(null, '', chatBasePath()); showEmptyState(); return; }
  if (id !== currentConvId) return;
  // Strip system messages from state (they're invalid API context), but attach
  // tool-call info to the preceding assistant message for the tool trace UI.
  const processed = [];
  (conv.messages || []).forEach(m => {
    if (m.role === 'system') {
      const toolCalls = parseToolsUsed(m.content);
      if (toolCalls) {
        const prev = processed.findLast(p => p.role === 'assistant');
        if (prev) prev._toolCalls = toolCalls;
      }
    } else {
      processed.push({ ...m });
    }
  });
  const nextModel = defaultSelectableModel();
  setCurrentConvId(id); setMessages(processed); setSelectedModel(nextModel);
  // Lock the topic for this conversation — it was set at creation and must not
  // drift as the user navigates the left nav. Every subsequent message in this
  // conversation sends the locked topic_slug as context, ensuring continuity of
  // the Layer 0 preamble regardless of which nav label is currently selected.
  window._lockedTopicSlug = conv.topic_slug || null;
  replaceConversationUrl(conv);
  if (conversationMode === 'session') setSavedSessionModel(nextModel);
  const liveEmpty = Number(conv.is_live) === 1 && processed.length === 0;
  $('#topbarTitle').textContent = conv.title || '';
  if (liveEmpty) {
    showNewChatView();
  } else {
    showChatView();
    renderMessages();
  }
  clearLoadStatus();
  document.dispatchEvent(new CustomEvent('conv-tags-changed', { detail: { tags: conv.tags || [] } }));
  if (isMobile()) toggleSidebar(false);
}

export async function loadConversationAndHighlight(id) {
  const mainArea = $('#mainArea');
  if (mainArea) mainArea.dataset.view = 'focus';
  await loadConversation(id);
}

export function newConversation() {
  setPendingActionChat(false);
  window._lockedTopicSlug = null;
  window._topicLatestState = '';
  window._topicResumeTitle = '';
  window._topicNextAction = '';
  setSelectedLabel(null);
  setCurrentConvId(null); setMessages([]); setAttachedFiles([]); setConversationCostCents(0);
  document.dispatchEvent(new CustomEvent('conv-tags-changed', { detail: { tags: [] } }));
  setSelectedModel(defaultSelectableModel());
  history.replaceState(null, '', chatBasePath());
  const inner = $('#messagesInner');
  if (inner) inner.innerHTML = '';
  showNewChatView();
  updateGreeting();
  renderLabels();
  clearLoadStatus();
  if (isMobile()) toggleSidebar(false);
}

export function newActionConversation() {
  newConversation();
  setPendingActionChat(true);
  const input = $('.chat-input');
  if (input) input.focus();
}

export async function quickArchive(id) {
  await fetchJSON('/api/conversations/' + id + '/archive', { method: 'POST' });
  if (id === currentConvId) { setCurrentConvId(null); setMessages([]); }
  loadConversations(); showToast('Archived');
}

export function quickDelete(id) {
  showConfirmModal('Delete', 'Permanently delete this conversation?', 'Delete', true, async () => {
    await fetchJSON('/api/conversations/' + id, { method: 'DELETE' });
    if (id === currentConvId) { setCurrentConvId(null); setMessages([]); }
    loadConversations();
  });
}

export async function toggleStar(id, pinned) {
  await fetchJSON('/api/conversations/' + id + '/pin', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned }) });
  loadConversations(); showToast(pinned ? 'Starred' : 'Unstarred');
}

export function updateGreeting() {
  const el = $('#greeting');
  const nextEl = $('#greetingNext');
  if (!el) return;
  el.classList.remove('is-topic-resume');
  const h = new Date().getHours();
  el.textContent = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  if (nextEl) {
    nextEl.textContent = '';
    nextEl.hidden = true;
  }
}

function showNewChatView() {
  window.robotdojoContext = { id: '__new__' };
  setView('new-chat');
  const emptyPrompt = $('#emptyPrompt');
  if (emptyPrompt) { emptyPrompt.innerHTML = buildInputBox(); bindInputEvents('emptyPrompt'); }
}

export function showEmptyState() {
  newConversation();
}

export function showChatView() {
  const emptyPrompt = $('#emptyPrompt'); if (emptyPrompt) emptyPrompt.innerHTML = '';
  setView('focus');
  $('#inputArea').innerHTML = buildInputBox();
  bindInputEvents('inputArea');
}

export function showListView() {
  newConversation();
}

export function switchNavItem(_item) {
  if (isMobile()) toggleSidebar(false);
}

// st_01b16272 — chat's search box finds past conversation threads, not
// people. Renders into the shared persistent-search dropdown (the same
// `.persistent-search-results` container shell-search.js creates for the
// unified box), so keyboard nav (Arrow keys, Enter, Escape, outside-click)
// and CSS come for free from the shared shell.
export function renderSearchResults(results, target) {
  const convResults = results.filter(r => r._type !== 'task');
  target.innerHTML = convResults.length ? convResults.map((r, i) => {
    const label = r.archived ? '<span class="sr-type">Archived</span>' : '';
    const topicBadge = r._topic ? `<span class="sr-type">${esc(r._topic)}</span>` : '';
    const snippet = r._matchSnippet ? `<div class="sr-snippet">${esc(r._matchSnippet)}</div>` : '';
    const date = r.updated_at ? new Date(r.updated_at).toLocaleDateString() : '';
    return `<div class="search-result${i === 0 ? ' search-result-active' : ''}" data-action="searchResultClick" data-id="${esc(r.id)}">
      <span class="material-symbols-outlined icon-sm sr-icon">chat</span>
      <div class="sr-main"><span class="sr-title">${esc(r.title)}</span>${snippet}</div>${topicBadge}${label}
      <span class="sr-date">${date}</span>
    </div>`;
  }).join('') : '<div class="search-empty">No results</div>';
}

export async function doSearch(q) {
  const clearBtn = $('#persistentSearchClear');
  const trimmed = q.trim();
  if (!trimmed) {
    if (typeof closePersistentSearchResults === 'function') closePersistentSearchResults();
    if (clearBtn) clearBtn.classList.remove('visible');
    return;
  }
  if (clearBtn) clearBtn.classList.add('visible');
  try {
    const res = await fetchJSON('/api/conversations/search?q=' + encodeURIComponent(trimmed));
    if (!res) return;
    let dropdown = $('.persistent-search-results');
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.className = 'persistent-search-results';
      const searchEl = $('#persistentSearch');
      (searchEl ? searchEl.parentElement : $('#globalTopbar'))?.appendChild(dropdown);
    }
    renderSearchResults(res.results || [], dropdown);
  } catch (err) { console.error('[chat] Search failed:', err.message); }
}

// ─── Labels / Topic Nav ───────────────────────────────────────────
// Single data model: user_topics via /api/labels (returns ALL T2 including hidden).
// T1 = groups (parent_slug IS NULL). T2 = topics (parent_slug IS NOT NULL).
// Canonical visibility for both levels: visible=true means shown, false means hidden.
// SortableJS owns all drag. CRUD handlers wired inline on DOM creation — no querySelectorAll loops.

let editModeActive = false;
let currentConvTags = [];
let _navSortables = []; // ALL instances, destroyed on every re-render

async function _navPut(slug, body) {
  const res = await fetchJSON('/api/topics/' + encodeURIComponent(slug), {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res) showToast('Could not save that topic change.');
  return res;
}

async function _navBatchOrder(parent_slug, slugs) {
  if (Array.isArray(parent_slug)) {
    slugs = parent_slug;
    parent_slug = undefined;
  }
  const body = { slugs };
  if (parent_slug !== undefined) body.parent_slug = parent_slug || null;
  return fetchJSON('/api/topics/batch-order', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function _navDelete(slug, displayName) {
  const r = await fetch('/api/topics/' + encodeURIComponent(slug), { method: 'DELETE' });
  const data = await r.json().catch(() => ({}));
  if (data.needsConfirm) {
    if (!confirm(`Delete "${displayName}" and all ${data.childCount} subtopic${data.childCount !== 1 ? 's' : ''}?`)) return;
    await fetch('/api/topics/' + encodeURIComponent(slug), {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }),
    });
  }
  await reloadLabelsAndConvs();
}

export function renderLabels() {
  const list = $('#topicList');
  if (!list) return;

  // Destroy ALL prior sortable instances before clearing DOM
  _navSortables.forEach(s => { try { s.destroy(); } catch {} });
  _navSortables = [];
  list.innerHTML = '';

  const belt = window._currentBelt || 'black';

  const groups = resolveNavGroups(window._topicGroups, labels);
  const tree = buildTopicNavModel(labels, window._topicGroups, { editMode: editModeActive });
  const isFlat = shouldFlattenTopicNav(groups);

  // Build a T2 topic row with inline event handlers
  function topicRow(l, isChild) {
    const row = document.createElement('div');
    const slug = l.context || l.slug || l.name;
    const isTagged = currentConvTags.includes(l.name);
    const visible = l.visible !== 0 && l.visible !== false;
    row.className = 'label-item' + (isChild ? ' label-child' : '') +
      (selectedLabel === l.name ? ' active' : '') +
      (isTagged ? ' tagged' : '') +
      (!visible ? ' label-hidden' : '');
    row.dataset.slug = slug;
    row.dataset.context = slug;
    const icon = materialIconName(l.icon || LABEL_ICONS[l.name] || 'label');
    const drag = (belt !== 'white' && belt !== 'demo') ? `<span class="material-symbols-outlined drag-handle">drag_indicator</span>` : '';
    const addCtxHtml = '';
    let editHtml = '';
    if (editModeActive) {
      editHtml = `<span class="label-edit-actions">
        <span class="label-edit-btn nav-vis material-symbols-outlined" title="${visible ? 'Hide' : 'Show'}">${visible ? 'visibility' : 'visibility_off'}</span>
        <span class="label-edit-btn nav-edit material-symbols-outlined" title="Edit">edit</span>
        <span class="label-edit-btn nav-del material-symbols-outlined" title="Delete">delete</span>
      </span>`;
    }
    row.innerHTML = `${drag}<span class="material-symbols-outlined label-icon">${icon}</span><span class="label-name">${esc(l.name)}</span>${addCtxHtml}${editHtml}`;

    row.onclick = (e) => {
      if (e.target.closest('.label-edit-btn')) return;
      selectLabel(l.name);
    };
    row.oncontextmenu = (e) => openLabelContextMenu(e, l);

    if (editModeActive) {
      row.querySelector('.nav-vis').onclick = async (e) => {
        e.stopPropagation();
        await _navPut(slug, { visible: visible ? 0 : 1 });
        await reloadLabelsAndConvs();
      };
      row.querySelector('.nav-edit').onclick = (e) => {
        e.stopPropagation();
        showTopicModal('Edit Topic',
          { name: l.name, icon: l.icon || '', description: l.description || '' },
          async ({ name, icon, description }) => {
            await _navPut(slug, { label: name, icon, description });
            await reloadLabelsAndConvs();
          });
      };
      row.querySelector('.nav-del').onclick = async (e) => {
        e.stopPropagation();
        await _navDelete(slug, l.name);
      };
    }

    return row;
  }

  function paintTopic(l, isChild) {
    list.appendChild(topicRow(l, isChild));
  }

  if (isFlat) {
    const toShow = editModeActive ? (labels || []) : (labels || []).filter(isShown);
    toShow.forEach(l => paintTopic(l, false));
  } else {
    const groupsContainer = document.createElement('div');
    groupsContainer.className = 'label-groups-container';
    list.appendChild(groupsContainer);

    tree.sections.forEach(({ group: g, children: kids }) => {
      const gSlug = g.slug;
      const gVisible = isShown(g);
      const visibleKids = kids.filter(isShown);

      // Wrapper div — the unit SortableJS moves for T1 reorder
      const groupWrapper = document.createElement('div');
      groupWrapper.className = 'label-group-wrapper' + (!gVisible ? ' t1-hidden' : '');
      groupWrapper.dataset.slug = gSlug;

      // T1 group header row — visually distinct from T2 via .label-group-parent + edit mode styling
      const isGroupActive = selectedLabel && typeof selectedLabel === 'object' && selectedLabel.group === gSlug;
      const isCollapsed = !!collapsedGroups[gSlug];
      const groupRow = document.createElement('div');
      groupRow.className = 'label-item label-group-parent' + (isGroupActive ? ' active' : '') + (!gVisible ? ' label-hidden' : '');
      groupRow.dataset.slug = gSlug;
      let t1DragHtml = '';
      let t1EditHtml = '';
      if (editModeActive) {
        t1DragHtml = `<span class="material-symbols-outlined t1-drag-handle">drag_indicator</span>`;
        t1EditHtml = `<span class="label-edit-actions">
          <span class="label-edit-btn t1-nav-vis material-symbols-outlined" title="${gVisible ? 'Hide group' : 'Show group'}">${gVisible ? 'visibility' : 'visibility_off'}</span>
          <span class="label-edit-btn t1-nav-edit material-symbols-outlined" title="Edit Group">edit</span>
          <span class="label-edit-btn t1-nav-del material-symbols-outlined" title="Delete Group">delete</span>
        </span>`;
      }
      groupRow.innerHTML = `${t1DragHtml}<span class="material-symbols-outlined label-icon">${materialIconName(g.icon || 'folder', 'folder')}</span><span class="label-name">${esc(g.name)}</span><span class="group-chevron">${isCollapsed ? '+' : '−'}</span>${t1EditHtml}`;
      groupRow.onclick = (e) => {
        if (e.target.closest('.label-edit-btn') || e.target.closest('.t1-drag-handle')) return;
        if (editModeActive) return;
        collapsedGroups[gSlug] = !collapsedGroups[gSlug];
        renderLabels();
      };
      groupRow.querySelector('.group-chevron').onclick = (e) => {
        e.stopPropagation();
        collapsedGroups[gSlug] = !collapsedGroups[gSlug];
        renderLabels();
      };
      if (editModeActive) {
        groupRow.querySelector('.t1-nav-vis').onclick = async (e) => {
          e.stopPropagation();
          await _navPut(gSlug, { visible: gVisible ? 0 : 1 });
          await reloadLabelsAndConvs();
        };
        groupRow.querySelector('.t1-nav-edit').onclick = (e) => {
          e.stopPropagation();
          showTopicModal('Edit Group',
            { name: g.name, icon: g.icon || 'folder', description: g.description || '' },
            async ({ name, icon, description }) => {
              await _navPut(gSlug, { label: name, icon, description });
              await reloadLabelsAndConvs();
            }, { isGroup: true });
        };
        groupRow.querySelector('.t1-nav-del').onclick = async (e) => {
          e.stopPropagation();
          await _navDelete(gSlug, g.name);
        };
      }
      groupWrapper.appendChild(groupRow);

      if (!isCollapsed) {
        const container = document.createElement('div');
        container.className = 'label-group-container' + (!gVisible ? ' under-hidden-t1' : '');
        container.dataset.parentSlug = gSlug;
        const toShow = editModeActive ? kids : visibleKids;
        toShow.forEach(l => container.appendChild(topicRow(l, true)));
        groupWrapper.appendChild(container);

        // T2 SortableJS — Black Belt edit mode only.
        if (belt === 'black' && editModeActive) {
          const s = new Sortable(container, {
            group: { name: 'topics', pull: true, put: true },
            animation: 150,
            handle: '.drag-handle',
            onEnd: async (evt) => {
              if (evt.from === evt.to) {
                // Reorder within same group — serialize all slugs in new order
                const slugs = [...evt.to.children].map(el => el.dataset.slug).filter(Boolean);
                await _navBatchOrder(evt.to.dataset.parentSlug || null, slugs);
              } else {
                // Cross-group move — update parent_slug, then rewrite both sibling sets.
                const slug = evt.item.dataset.slug;
                if (!slug) return;
                await _navPut(slug, { parent_slug: evt.to.dataset.parentSlug || null });
                const targetSlugs = [...evt.to.children].map(el => el.dataset.slug).filter(Boolean);
                const sourceSlugs = [...evt.from.children].map(el => el.dataset.slug).filter(Boolean);
                await _navBatchOrder(evt.to.dataset.parentSlug || null, targetSlugs);
                if (sourceSlugs.length > 0) await _navBatchOrder(evt.from.dataset.parentSlug || null, sourceSlugs);
              }
              await reloadLabelsAndConvs();
            },
          });
          _navSortables.push(s);
        }
      }
      groupsContainer.appendChild(groupWrapper);
    });

    // T1 group reorder — SortableJS on groupsContainer (Black Belt edit mode)
    if (belt === 'black' && editModeActive) {
      const s = new Sortable(groupsContainer, {
        animation: 150,
        handle: '.t1-drag-handle',
        draggable: '.label-group-wrapper',
        onEnd: async () => {
          const slugs = [...groupsContainer.children].map(el => el.dataset.slug).filter(Boolean);
          await _navBatchOrder(null, slugs);
          await reloadLabelsAndConvs();
        },
      });
      _navSortables.push(s);
    }

    tree.orphans.forEach(l => paintTopic(l, false));
  }

  // Manage Topics toggle
  if (belt !== 'demo') {
    const sep2 = document.createElement('div'); sep2.className = 'label-separator'; list.appendChild(sep2);
    const manageRow = document.createElement('div');
    manageRow.className = 'label-item label-manage' + (editModeActive ? ' active' : '');
    manageRow.innerHTML = `<span class="material-symbols-outlined label-icon">${editModeActive ? 'check' : 'settings'}</span><span class="label-name">${editModeActive ? 'Done' : 'Manage Topics'}</span>`;
    manageRow.onclick = () => {
      editModeActive = !editModeActive;
      document.body.classList.toggle('topics-edit-mode', editModeActive);
      renderLabels();
    };
    list.appendChild(manageRow);

    if (editModeActive) {
      if (belt === 'white') {
        // WB: inline quick-add
        const form = document.createElement('div');
        form.style.cssText = 'padding:6px 10px;display:flex;gap:6px;';
        const inp = document.createElement('input');
        inp.type = 'text'; inp.placeholder = 'Topic name';
        inp.style.cssText = 'flex:1;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:4px;background:var(--bg2);color:var(--text1)';
        const btn = document.createElement('button');
        btn.textContent = 'Add';
        btn.style.cssText = 'font-size:12px;padding:4px 8px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer';
        btn.onclick = async () => {
          const name = inp.value.trim();
          if (!name) return;
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
          await fetchJSON('/api/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, label: name }) });
          inp.value = '';
          await reloadLabelsAndConvs();
        };
        form.appendChild(inp); form.appendChild(btn);
        list.appendChild(form);
      } else {
        // BB: Add Group + Add Topic
        const btns = document.createElement('div');
        btns.style.cssText = 'padding:4px 10px;display:flex;gap:6px;';
        const addGroupBtn = document.createElement('button');
        addGroupBtn.textContent = '+ Group';
        addGroupBtn.style.cssText = 'flex:1;font-size:12px;padding:4px 8px;background:var(--bg2);color:var(--text1);border:1px solid var(--border);border-radius:4px;cursor:pointer';
        addGroupBtn.onclick = () => {
          showTopicModal('New Group', { name: '', icon: 'folder', description: '' },
            async ({ name, icon, description }) => {
              if (!name.trim()) return;
              const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
              await fetchJSON('/api/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, label: name, icon, description, parent_slug: null }) });
              await reloadLabelsAndConvs();
            }, { isGroup: true });
        };
        const addTopicBtn = document.createElement('button');
        addTopicBtn.textContent = '+ Topic';
        addTopicBtn.style.cssText = 'flex:1;font-size:12px;padding:4px 8px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer';
        addTopicBtn.onclick = () => addLabel();
        btns.appendChild(addGroupBtn); btns.appendChild(addTopicBtn);
        list.appendChild(btns);
      }
    }
  }
}

// st_6360589a: The "Context: {label}" chip is removed. The left-nav highlight
// is the single source of truth for which topic is active — a redundant
// chip in the topbar duplicates that signal and is the exact anti-pattern
// the Apple HIG warns against ("if titling seems redundant, leave it empty").

export function isInboxNavLabel(label) {
  if (label == null) return true;
  if (label === 'all' || label === 'starred' || label === 'actions') return true;
  return false;
}

export async function openTopicLive(slug, { labelName } = {}) {
  const topicSlug = String(slug || '').trim();
  if (!topicSlug || isInboxNavLabel(topicSlug)) return;
  const prev = window._lockedTopicSlug;
  if (prev && prev !== topicSlug) {
    fetch('/api/chat/session-close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: JSON.stringify({ topic: prev, reason: 'leave-topic' }),
    }).catch(() => {});
  }
  const name = labelName || labels.find((l) => (l.slug || l.context) === topicSlug)?.name || topicSlug;
  setSelectedLabel(name);
  window._lockedTopicSlug = topicSlug;
  setCurrentConvId(null);
  setMessages([]);
  setAttachedFiles([]);
  setConversationCostCents(0);
  document.dispatchEvent(new CustomEvent('conv-tags-changed', { detail: { tags: [] } }));
  const inner = $('#messagesInner');
  if (inner) inner.innerHTML = '';
  setLoadStatus('Opening conversation...');
  try {
    const data = await fetchJSON('/api/topics/' + encodeURIComponent(topicSlug) + '/live');
    if (!data?.conversationId) throw new Error('no_live');
    setCurrentConvId(data.conversationId);
    window._lockedTopicSlug = data.topicSlug || topicSlug;
    history.replaceState(null, '', '/chat/topic/' + encodeURIComponent(data.topicSlug || topicSlug));
    const titleEl = $('#topbarTitle');
    if (titleEl) titleEl.textContent = name;
    window._topicLatestState = String(data.latestState || '').trim();
    window._topicResumeTitle = String(data.title || '').trim();
    window._topicNextAction = String(data.nextAction || '').trim();
    showNewChatView();
    updateGreeting();
    clearLoadStatus();
    renderLabels();
    if (isMobile()) toggleSidebar(false);
  } catch (err) {
    clearLoadStatus();
    showToast('Could not open topic');
  }
}

export async function openSubjectLive(kind, id, { labelName } = {}) {
  const k = String(kind || '').trim().toLowerCase();
  const i = String(id || '').trim();
  if (!k || !i) return;
  const name = labelName || i;
  setSelectedLabel(name);
  window._lockedTopicSlug = `${k}:${i}`;
  setCurrentConvId(null);
  setMessages([]);
  setAttachedFiles([]);
  setConversationCostCents(0);
  document.dispatchEvent(new CustomEvent('conv-tags-changed', { detail: { tags: [] } }));
  const inner = $('#messagesInner');
  if (inner) inner.innerHTML = '';
  setLoadStatus('Opening conversation...');
  try {
    const data = await fetchJSON('/api/subjects/' + encodeURIComponent(k) + '/' + encodeURIComponent(i) + '/live');
    if (!data?.conversationId) throw new Error('no_live');
    setCurrentConvId(data.conversationId);
    window._lockedTopicSlug = data.subjectKey || `${k}:${i}`;
    history.replaceState(null, '', '/chat/' + encodeURIComponent(k) + '/' + encodeURIComponent(i));
    const titleEl = $('#topbarTitle');
    if (titleEl) titleEl.textContent = name;
    window._topicLatestState = String(data.latestState || '').trim();
    window._topicResumeTitle = String(data.title || '').trim();
    window._topicNextAction = String(data.nextAction || '').trim();
    showNewChatView();
    updateGreeting();
    clearLoadStatus();
    if (isMobile()) toggleSidebar(false);
  } catch (err) {
    clearLoadStatus();
    showToast('Could not open chat');
  }
}

export async function openTopicHistory(slug) {
  const topicSlug = String(slug || '').trim();
  if (!topicSlug) return;
  setLoadStatus('Opening conversation...');
  try {
    const data = await fetchJSON('/api/topics/' + encodeURIComponent(topicSlug) + '/history');
    setMessages(Array.isArray(data?.messages) ? data.messages : []);
    showChatView();
    renderMessages();
    clearLoadStatus();
  } catch (err) {
    clearLoadStatus();
    showToast('Could not open history');
  }
}

function selectLabel(labelName) {
  if (isInboxNavLabel(labelName)) {
    setSelectedLabel(labelName);
    window._lockedTopicSlug = null;
    renderLabels();
    newConversation();
    return;
  }
  if (labelName && typeof labelName === 'object' && labelName.group) {
    collapsedGroups[labelName.group] = !collapsedGroups[labelName.group];
    renderLabels();
    return;
  }
  const row = labels.find((l) => l.name === labelName);
  const slug = row?.slug || row?.context || labelName;
  openTopicLive(slug, { labelName: row?.name || labelName });
}

export async function reloadLabelsAndConvs() {
  const store = getTopicStore();
  if (store) {
    const result = await store.refresh();
    if (!result?.ok) return;
  } else {
    const data = await fetchJSON('/api/labels');
    if (!data?.labels) return;
    setLabels(data.labels);
    setInboxCount(data.inboxCount || 0);
    if (data.groups) window._topicGroups = data.groups;
  }
  renderLabels();
  loadConversations();
}

// Icon picker grid — comprehensive Material Symbols catalog for topic creation
const TOPIC_ICONS_ALL = [
  'home',
  'menu',
  'close',
  'search',
  'settings',
  'arrow_back',
  'arrow_forward',
  'arrow_upward',
  'arrow_downward',
  'chevron_left',
  'chevron_right',
  'expand_more',
  'expand_less',
  'more_vert',
  'more_horiz',
  'menu_open',
  'drag_indicator',
  'open_in_new',
  'launch',
  'fullscreen',
  'fullscreen_exit',
  'zoom_in',
  'zoom_out',
  'first_page',
  'last_page',
  'navigate_before',
  'navigate_next',
  'unfold_more',
  'unfold_less',
  'add',
  'remove',
  'edit',
  'delete',
  'delete_forever',
  'save',
  'send',
  'share',
  'print',
  'download',
  'upload',
  'refresh',
  'sync',
  'sync_alt',
  'replay',
  'undo',
  'redo',
  'copy_all',
  'content_copy',
  'content_cut',
  'content_paste',
  'select_all',
  'clear',
  'block',
  'lock',
  'lock_open',
  'visibility',
  'visibility_off',
  'check',
  'check_circle',
  'cancel',
  'help',
  'help_outline',
  'info',
  'info_outline',
  'warning',
  'error',
  'report',
  'flag',
  'bookmark',
  'bookmark_border',
  'star',
  'star_border',
  'favorite',
  'favorite_border',
  'thumb_up',
  'thumb_down',
  'grade',
  'label',
  'label_important',
  'sell',
  'highlight',
  'pin',
  'push_pin',
  'attach_file',
  'link',
  'link_off',
  'qr_code',
  'filter_alt',
  'sort',
  'tune',
  'build',
  'handyman',
  'construction',
  'engineering',
  'science',
  'biotech',
  'notifications',
  'notifications_active',
  'notifications_none',
  'notification_add',
  'alarm',
  'alarm_on',
  'access_time',
  'schedule',
  'timer',
  'hourglass_empty',
  'hourglass_full',
  'pending',
  'watch_later',
  'update',
  'autorenew',
  'loop',
  'cached',
  'published_with_changes',
  'new_releases',
  'announcement',
  'inbox',
  'drafts',
  'outbox',
  'forum',
  'chat',
  'chat_bubble',
  'comment',
  'message',
  'sms',
  'mail',
  'email',
  'markunread',
  'mark_email_read',
  'unsubscribe',
  'move_to_inbox',
  'article',
  'description',
  'notes',
  'note',
  'note_add',
  'sticky_note_2',
  'create',
  'edit_note',
  'text_snippet',
  'document_scanner',
  'receipt',
  'receipt_long',
  'list',
  'ballot',
  'checklist',
  'task',
  'task_alt',
  'assignment',
  'assignment_turned_in',
  'assignment_late',
  'event_note',
  'post_add',
  'library_books',
  'book',
  'menu_book',
  'auto_stories',
  'import_contacts',
  'feed',
  'rss_feed',
  'dynamic_feed',
  'format_list_bulleted',
  'format_list_numbered',
  'work',
  'work_outline',
  'business',
  'business_center',
  'corporate_fare',
  'domain',
  'storefront',
  'store',
  'local_mall',
  'shopping_bag',
  'shopping_cart',
  'inventory',
  'inventory_2',
  'category',
  'point_of_sale',
  'price_check',
  'money',
  'payments',
  'credit_card',
  'account_balance',
  'account_balance_wallet',
  'savings',
  'paid',
  'currency_exchange',
  'attach_money',
  'money_off',
  'trending_up',
  'trending_down',
  'analytics',
  'bar_chart',
  'pie_chart',
  'show_chart',
  'leaderboard',
  'insights',
  'data_usage',
  'query_stats',
  'assessment',
  'dashboard',
  'speed',
  'real_estate_agent',
  'handshake',
  'groups',
  'group',
  'group_add',
  'people',
  'person',
  'person_add',
  'person_remove',
  'account_circle',
  'manage_accounts',
  'supervisor_account',
  'admin_panel_settings',
  'badge',
  'contact_page',
  'contacts',
  'recent_actors',
  'code',
  'terminal',
  'developer_mode',
  'integration_instructions',
  'data_object',
  'data_array',
  'api',
  'webhook',
  'cloud',
  'cloud_upload',
  'cloud_download',
  'cloud_sync',
  'cloud_done',
  'cloud_off',
  'cloud_queue',
  'storage',
  'dns',
  'computer',
  'laptop',
  'desktop_windows',
  'monitor',
  'smartphone',
  'tablet',
  'watch',
  'devices',
  'device_hub',
  'router',
  'wifi',
  'wifi_off',
  'bluetooth',
  'usb',
  'memory',
  'developer_board',
  'microchip',
  'smart_toy',
  'precision_manufacturing',
  'settings_input_component',
  'cable',
  'keyboard',
  'mouse',
  'scanner',
  'camera',
  'camera_alt',
  'photo_camera',
  'videocam',
  'mic',
  'headphones',
  'speaker',
  'tv',
  'radio',
  'hardware',
  'hub',
  'lan',
  'network_node',
  'school',
  'local_library',
  'class',
  'psychology',
  'architecture',
  'calculate',
  'functions',
  'history_edu',
  'lightbulb',
  'tips_and_updates',
  'rocket_launch',
  'explore',
  'travel_explore',
  'public',
  'language',
  'translate',
  'spellcheck',
  'abc',
  'format_shapes',
  'palette',
  'draw',
  'brush',
  'design_services',
  'grid_view',
  'view_module',
  'local_hospital',
  'medical_services',
  'health_and_safety',
  'monitor_heart',
  'fitness_center',
  'sports_gymnastics',
  'directions_run',
  'directions_walk',
  'self_improvement',
  'spa',
  'accessibility',
  'accessibility_new',
  'medication',
  'vaccines',
  'bloodtype',
  'psychiatry',
  'ophthalmology',
  'dentistry',
  'nutrition',
  'set_meal',
  'restaurant',
  'local_dining',
  'dinner_dining',
  'breakfast_dining',
  'lunch_dining',
  'food_bank',
  'kitchen',
  'blender',
  'microwave',
  'water_drop',
  'sports',
  'sports_score',
  'sports_basketball',
  'sports_soccer',
  'sports_tennis',
  'sports_golf',
  'sports_baseball',
  'sports_football',
  'sports_volleyball',
  'pool',
  'hiking',
  'nordic_walking',
  'cycling',
  'kayaking',
  'skateboarding',
  'snowboarding',
  'surfing',
  'rowing',
  'house',
  'cottage',
  'apartment',
  'villa',
  'cabin',
  'holiday_village',
  'family_home',
  'bed',
  'bedroom_baby',
  'bathroom',
  'living',
  'chair',
  'table_restaurant',
  'sofa',
  'balcony',
  'deck',
  'yard',
  'garage',
  'door_front',
  'fence',
  'grass',
  'park',
  'forest',
  'child_care',
  'crib',
  'baby_changing_station',
  'family_restroom',
  'stroller',
  'elderly',
  'pets',
  'cruelty_free',
  'local_florist',
  'potted_plant',
  'eco',
  'nature',
  'compost',
  'cleaning_services',
  'plumbing',
  'electrical_services',
  'hvac',
  'invoice',
  'request_quote',
  'price_change',
  'percent',
  'balance',
  'gavel',
  'policy',
  'privacy_tip',
  'verified_user',
  'security',
  'shield',
  'key',
  'safe',
  'vault',
  'flight',
  'flight_takeoff',
  'flight_land',
  'connecting_airports',
  'local_airport',
  'directions_car',
  'car_rental',
  'directions_bus',
  'train',
  'subway',
  'directions_subway',
  'directions_boat',
  'sailing',
  'directions_bike',
  'electric_bike',
  'electric_scooter',
  'local_taxi',
  'local_shipping',
  'rv_hookup',
  'time_to_leave',
  'map',
  'navigation',
  'my_location',
  'location_on',
  'place',
  'terrain',
  'landscape',
  'beach_access',
  'hotel',
  'local_hotel',
  'luggage',
  'tour',
  'attractions',
  'museum',
  'theater_comedy',
  'stadium',
  'nightlife',
  'casino',
  'call',
  'phone',
  'phone_iphone',
  'video_call',
  'voice_chat',
  'contact_support',
  'support_agent',
  'record_voice_over',
  'interpreter_mode',
  'volunteer_activism',
  'diversity_1',
  'diversity_2',
  'diversity_3',
  'celebration',
  'cake',
  'card_giftcard',
  'redeem',
  'emoji_events',
  'military_tech',
  'workspace_premium',
  'verified',
  'movie',
  'smart_display',
  'play_circle',
  'pause_circle',
  'stop_circle',
  'fast_forward',
  'fast_rewind',
  'skip_next',
  'skip_previous',
  'shuffle',
  'repeat',
  'queue_music',
  'music_note',
  'music_video',
  'album',
  'podcasts',
  'library_music',
  'sports_esports',
  'videogame_asset',
  'games',
  'theaters',
  'local_movies',
  'camera_roll',
  'collections',
  'photo_library',
  'image',
  'broken_image',
  'gif',
  'slideshow',
  'local_cafe',
  'local_bar',
  'local_pizza',
  'local_grocery_store',
  'local_pharmacy',
  'local_gas_station',
  'local_laundry_service',
  'local_car_wash',
  'local_atm',
  'local_post_office',
  'local_police',
  'local_fire_department',
  'location_city',
  'golf_course',
  'hot_tub',
  'church',
  'find_in_page',
  'manage_search',
  'saved_search',
  'youtube_searched_for',
  'troubleshoot',
  'rule',
  'fact_check',
  'unpublished',
  'photo',
  'crop',
  'flip',
  'rotate_90_degrees_ccw',
  'grain',
  'gradient',
  'opacity',
  'colorize',
  'brightness_high',
  'contrast',
  'filter_vintage',
  'local_see',
  'format_paint',
  'format_color_fill',
  'format_color_text',
  'text_format',
  'title',
  'edit_document',
  'auto_fix_high',
  'auto_awesome',
  'extension',
  'apps',
  'widgets',
  'view_in_ar',
  'layers',
  'texture',
  'blur_on',
  'blur_off',
  'center_focus_strong',
  'loupe',
  'wb_sunny',
  'wb_cloudy',
  'wb_twilight',
  'storm',
  'thunderstorm',
  'water',
  'air',
  'fire',
  'mountains',
  'dark_mode',
  'light_mode',
  'nightlight',
  'ac_unit',
  'thermostat',
  'wind_power',
  'solar_power',
  'bolt',
  'flash_on',
  'power',
  'battery_full',
  'battery_charging_full',
  'recycling',
  'delete_sweep',
  'auto_delete',
  'history',
  'restore',
  'archive',
  'star_half',
  'sentiment_satisfied',
  'sentiment_neutral',
  'sentiment_dissatisfied',
  'mood',
  'mood_bad',
  'face',
  'emoji_emotions',
  'emoji_people',
  'emoji_nature',
  'emoji_food_beverage',
  'emoji_transportation',
  'emoji_flags',
  'emoji_objects',
  'emoji_symbols',
  'circle',
  'square',
  'pentagon',
  'hexagon',
  'diamond',
  'change_history',
  'crop_square',
  'crop_circle',
  'crop_portrait',
  'crop_landscape',
  'rocket',
  'satellite',
  'satellite_alt',
  'backup',
  'cloud_circle',
  'folder',
  'folder_open',
  'folder_special',
  'folder_shared',
  'snippet_folder',
  'source',
  'schema',
  'table_chart',
  'spreadsheet',
  'pivot_table_chart',
  'waterfall_chart',
  'area_chart',
  'stacked_bar_chart',
  'scatter_plot',
  'timeline',
  'ssid_chart',
  'monitoring',
  'account_tree',
  'device_tree',
  'flowchart',
  'org_chart',
  'call_split',
  'merge',
  'compare',
  'difference',
  'find_replace',
  'wrap_text',
  'format_indent_increase',
  'format_indent_decrease',
  'format_align_left',
  'format_align_center',
  'format_align_right',
  'format_align_justify',
  'format_bold',
  'format_italic',
  'format_underlined',
  'strikethrough_s',
  'subscript',
  'superscript',
  'bug_report',
  'pest_control',
  'smoke_detector',
  'home_work',
  'currency_bitcoin',
  'currency_pound',
  'currency_euro',
  'currency_yen',
  'currency_franc',
  'currency_ruble',
  'currency_rupee',
  'festival',
  'event',
  'calendar_today',
  'calendar_month',
  'date_range',
  'today',
  'upcoming',
  'next_week',
  'next_plan',
  'snooze',
  'wb_incandescent',
  'weekend',
  'shower',
  'iron',
  'dry',
  'dry_cleaning',
  'laundry',
  'bedroom_child',
  'child_friendly',
  'pregnant_woman',
  'wc',
  'man',
  'woman',
  'boy',
  'girl',
  'baby',
  'elderly_woman',
  'smart_home',
  'home_iot_device',
  'nest_cam_wired',
  'sensors',
  'memory_alt',
  'developer_mode_tv',
  'code_blocks',
  'deployed_code',
  'deployed_code_update',
  'heap_snapshot_thumbnail',
  'adb',
  'phonelink',
  'phonelink_setup',
  'app_settings_alt',
  'system_update',
  'system_update_alt',
  'tap_and_play',
  'nfc',
  'qr_code_2',
  'qr_code_scanner',
  'robot',
  'neurology',
  'psychology_alt',
  'cognition',
  'model_training',
  'search_insights',
  'add_circle',
  'remove_circle',
  'add_box',
  'indeterminate_check_box',
  'check_box',
  'check_box_outline_blank',
  'radio_button_checked',
  'radio_button_unchecked',
  'toggle_on',
  'toggle_off',
  'power_settings_new',
  'restart_alt',
  'stop',
  'play_arrow',
  'pause',
  'replay_5',
  'replay_10',
  'forward_5',
  'forward_10',
  'slow_motion_video',
  'high_quality',
  'hd',
  'subtitles',
  'closed_caption',
  'volume_up',
  'volume_down',
  'volume_off',
  'volume_mute',
  'equalizer',
  'graphic_eq',
  'surround_sound',
  'insert_drive_file',
  'draft',
  'file_copy',
  'file_open',
  'file_present',
  'file_download',
  'file_upload',
  'upload_file',
  'download_for_offline',
  'folder_zip',
  'compress',
  'expand',
  'open_with',
  'move_up',
  'move_down',
  'swap_vert',
  'swap_horiz',
  'import_export',
  'person_pin',
  'person_search',
  'person_off',
  'reduce_capacity',
  'waving_hand',
  'front_hand',
  'back_hand',
  'thumbs_up_down',
  'diversity_4',
  'groups_2',
  'group_work',
  'connect_without_contact',
  'social_distance',
  'follow_the_signs',
  'waves',
  'flood',
  'severe_cold',
  'foggy',
  'cloudy',
  'partly_cloudy_day',
  'partly_cloudy_night',
  'sunny',
  'nights_stay',
  'rainy',
  'snowing',
  'tornado',
  'cyclone',
  'tsunami',
  'fireplace',
  'outdoor_grill',
  'barbeque',
  'agriculture',
  'landslide',
  'humidity_high',
  'humidity_low',
  'dew_point',
  'bedroom_parent',
  'dining',
  'bathtub',
  'toilet',
  'countertops',
  'door_back',
  'window',
  'blinds',
  'curtains',
  'light',
  'ceiling_fan',
  'heat',
  'device_thermostat',
  'propane',
  'propane_tank',
  'oil_barrel',
  'solar_panel',
  'ev_station',
  'charging_station',
  'garage_door',
  'smoke_free',
  'carbon_monoxide_detector',
  'desk',
  'meeting_room',
  'co_present',
  'presentation',
  'cast_for_education',
  'event_seat',
  'room',
  'add_location',
  'location_off',
  'wrong_location',
  'gps_fixed',
  'gps_off',
  'directions',
  'near_me',
  'near_me_disabled',
  'roundabout_right',
  'merge_type',
  'u_turn_left',
  'discount',
  'loyalty',
  'card_membership',
  'card_travel',
  'wallet',
  'contactless',
  'barcode',
  'warehouse',
  'forklift',
  'conveyor_belt',
  'factory',
  'health_metrics',
  'vital_signs',
  'cardiology',
  'orthopedics',
  'pulmonology',
  'gastroenterology',
  'clinical_notes',
  'lab_research',
  'coronavirus',
  'masks',
  'sanitizer',
  'soap',
  'medical_bag',
  'first_aid',
  'ambulance',
  'emergency',
  'sos',
  'crisis_alert',
  'sports_cricket',
  'sports_handball',
  'sports_hockey',
  'sports_kabaddi',
  'sports_martial_arts',
  'sports_mma',
  'sports_motorsports',
  'sports_rugby',
  'run_circle',
  'pedal_bike',
  'downhill_skiing',
  'sledding',
  'ice_skating',
  'paragliding',
  'kitesurfing',
  'scuba_diving',
  'graduated',
  'rewarded_ads',
  'recommend',
  'adjust',
  'all_inclusive',
  'anchor',
  'aod',
  'aspect_ratio',
  'atm',
  'attachment',
  'autoplay',
  'backpack',
  'blur_circular',
  'blur_linear',
  'border_all',
  'branding_watermark',
  'brightness_1',
  'brightness_2',
  'brightness_3',
  'bubble_chart',
  'call_to_action',
  'center_focus_weak',
  'change_circle',
  'clear_all',
  'color_lens',
  'color_swatch',
  'commit',
  'control_point',
  'copyright',
  'crop_free',
  'data_exploration',
  'deblur',
  'dehaze',
  'delivery_dining',
  'devices_other',
  'dialpad',
  'flip_camera_ios',
  'folder_copy',
  'generating_tokens',
  'gif_box',
  'hexagonal_prism',
  'hide_image',
  'invert_colors',
  'lens',
  'lens_blur',
  'looks',
  'looks_one',
  'looks_two',
  'looks_3',
  'looks_4',
  'looks_5',
  'looks_6',
  'mark_as_unread',
  'motion_blur',
  'network_check',
  'noise_control_off',
  'noise_aware',
  'open_in_browser',
  'open_in_full',
  'outbound',
  'pattern',
  'polymer',
  'power_off',
  'printer',
  'productivity',
  'read_more',
  'remove_red_eye',
  'screenshot',
  'screenshot_monitor',
  'sd_card',
  'settings_applications',
  'settings_backup_restore',
  'signal_cellular_alt',
  'signal_wifi_4_bar',
  'sim_card',
  'star_rate',
  'stacked_line_chart',
  'sticky_note',
  'straighten',
  'tab',
  'tag',
  'text_rotate_up',
  'text_rotation_none',
  'timer_off',
  'topic',
  'touch_app',
  'transform',
  'trending_flat',
  'trip_origin',
  'view_agenda',
  'view_array',
  'view_carousel',
  'view_column',
  'view_comfy',
  'view_compact',
  'view_day',
  'view_headline',
  'view_kanban',
  'view_list',
  'view_quilt',
  'view_sidebar',
  'view_stream',
  'view_timeline',
  'view_week',
  'vignette',
  'accessible',
  'accessible_forward',
  'account_box',
  'ad_units',
  'adaptive_audio_mic',
  'add_alarm',
  'add_alert',
  'add_business',
  'add_card',
  'add_chart',
  'add_comment',
  'add_location_alt',
  'add_moderator',
  'add_photo_alternate',
  'add_reaction',
  'add_road',
  'add_shopping_cart',
  'add_task',
  'add_to_drive',
  'add_to_home_screen',
  'add_to_queue',
  'adf_scanner',
  'ads_click',
  'agender',
  'airline_seat_flat',
  'airline_seat_individual_suite',
  'airline_seat_legroom_extra',
  'airline_seat_legroom_normal',
  'airline_seat_recline_extra',
];

// defaults may include: name, icon, description, groups (array of {slug,name} for group selector), parent_slug (pre-selected group)
function showTopicModal(title, defaults, cb, opts = {}) {
  const name = defaults?.name || '';
  const icon = defaults?.icon || 'label';
  const desc = defaults?.description || '';
  const groups = defaults?.groups || null;
  // null/undefined parent_slug → '' (Top Level). The select's "Top Level" option
  // has value="" so empty string represents top-level intent. Falsy ?? coalescing
  // is intentional — defaults?.parent_slug === null must resolve to '' (Top Level
  // selected), not fall through to the first group.
  const preselectedGroup = defaults?.parent_slug ?? '';
  const modal = $('#robotdojoModal');
  $('#modalTitle').textContent = title;
  $('#modalMessage').dataset.visible = 'false';
  $('#modalInput').dataset.visible = 'false';

  const content = modal.querySelector('.modal-content') || modal;
  let custom = modal.querySelector('.topic-modal-form');
  if (custom) custom.remove();

  custom = document.createElement('div');
  custom.className = 'topic-modal-form';

  const groupSelectHtml = groups?.length
    ? `<select class="topic-group-select" style="width:100%;padding:4px 6px;margin-bottom:6px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg2);color:var(--text1)">${
        `<option value=""${preselectedGroup === '' ? ' selected' : ''}>Top Level</option>` +
        groups.map(g => `<option value="${esc(g.slug)}"${g.slug === preselectedGroup ? ' selected' : ''}>${esc(g.name)}</option>`).join('')
      }</select>`
    : '';

  custom.innerHTML = `
    ${groupSelectHtml}
    <input type="text" class="topic-name-input" placeholder="Topic name" value="${esc(name)}">
    <input type="text" class="icon-search-input" placeholder="Search icons..." autocomplete="off" style="width:100%;padding:4px 8px;margin-bottom:6px;font-size:13px;border:1px solid var(--border);border-radius:4px;background:var(--bg2);color:var(--text1);box-sizing:border-box">
    <div class="topic-icon-grid" style="max-height:160px;overflow-y:auto">${TOPIC_ICONS_ALL.map(ic =>
      `<button class="topic-icon-btn${ic === icon ? ' selected' : ''}" data-icon="${ic}" title="${ic}"><span class="material-symbols-outlined">${ic}</span></button>`
    ).join('')}</div>
    ${opts.isGroup
      ? `<p style="margin:6px 0 0;font-size:12px;color:var(--text2);line-height:1.5">Context for this group is automatically derived from its subtopics — no description needed. Add subtopics to build richer context.</p>`
      : `<textarea class="topic-desc-input" rows="6" placeholder="Describe this topic in a sentence or two. Name the people, companies, places, and words that belong ONLY here — distinctive words pull the right information in; generic words (work, projects, planning) blur topics together. Dates help a lot where they apply (jobs, schools, eras), and use language distinct from your other topics — shared words make topics compete for the same content. Example: 'Northstar Lending (2021–2023) — mortgage technology: lending APIs, title data, loan origination.'">${esc(desc)}</textarea>`
    }`;
  const actionsEl = modal.querySelector('.modal-actions');
  (actionsEl?.parentNode || modal).insertBefore(custom, actionsEl);

  let selectedIcon = icon;

  // Wire icon search filter
  const searchInput = custom.querySelector('.icon-search-input');
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim().toLowerCase();
    custom.querySelectorAll('.topic-icon-btn').forEach(btn => {
      btn.style.display = (!query || btn.dataset.icon.includes(query)) ? '' : 'none';
    });
  });

  custom.querySelectorAll('.topic-icon-btn').forEach(btn => {
    btn.onclick = () => {
      custom.querySelectorAll('.topic-icon-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedIcon = btn.dataset.icon;
    };
  });

  const confirmBtn = $('#modalConfirmBtn');
  confirmBtn.textContent = 'Save';
  confirmBtn.className = 'confirm';
  confirmBtn.onclick = () => {
    const n = custom.querySelector('.topic-name-input').value.trim();
    const d = custom.querySelector('.topic-desc-input')?.value.trim() || '';
    const parentSlug = custom.querySelector('.topic-group-select')?.value || null;
    closeModal();
    modal.classList.remove('topic-modal');
    custom.remove();
    if (n) cb({ name: n, icon: selectedIcon, description: d || null, parent_slug: parentSlug });
  };
  // Wire cancel button to clean up the topic-modal class as well.
  const cancelBtn = modal.querySelector('.modal-actions .cancel');
  if (cancelBtn) {
    const prevCancel = cancelBtn.onclick;
    cancelBtn.onclick = (e) => {
      modal.classList.remove('topic-modal');
      if (custom.parentNode) custom.remove();
      if (prevCancel) prevCancel.call(cancelBtn, e);
    };
  }
  modal.classList.add('topic-modal');
  modal.classList.add('open');
  // focusDescription: when adding context, focus the description field instead of name.
  setTimeout(() => {
    const target = opts.focusDescription
      ? custom.querySelector('.topic-desc-input')
      : custom.querySelector('.topic-name-input');
    target?.focus();
  }, 50);
}

export function addLabel(defaultParentSlug) {
  const belt = window._currentBelt || 'black';
  const doShow = (groups) => {
    showTopicModal('New Topic', { groups, parent_slug: defaultParentSlug }, async ({ name, icon, description, parent_slug }) => {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');
      await fetchJSON('/api/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug, label: name, icon, description, parent_slug: parent_slug || null }) });
      await reloadLabelsAndConvs();
    });
  };
  if (belt === 'white') {
    doShow(null);
  } else {
    const groups = window._topicGroups?.map(g => ({ slug: g.slug, name: g.name })) || null;
    if (groups) {
      doShow(groups);
    } else {
      // _topicGroups not yet loaded — fetch first
      const store = getTopicStore();
      (store ? store.refresh() : fetchJSON('/api/labels').then((data) => ({ ok: !!data, payload: data })))
        .then((result) => {
          const groups = result?.payload?.groups || window._topicGroups || [];
          doShow(groups.map((g) => ({ slug: g.slug, name: g.name })));
        });
    }
  }
}

// renameLabel accepts a stable context slug (not a positional id that drifts after reload).
// Callers pass btn.dataset.context (the slug stored on the DOM element at render time).
export function renameLabel(context, cur) {
  const label = labels.find(l => (l.context || l.name.toLowerCase().replace(/\s+/g, '_')) === context);
  // df_d6970c76 Fix 2: prefer the real .slug from getLabels (the canonical DB
  // primary key) over the legacy .context field, which historically could fall
  // back to a name-derived form on a stale warm-cache hydration. With Fix 1
  // refreshing rd_warm_labels these stay identical, but reading .slug first
  // makes the rename PUT robust to any other code path that mutates label.context.
  const slug = label?.slug || label?.context || context;
  showTopicModal('Edit Topic', { name: cur || label?.name || slug, icon: label?.icon, description: label?.description }, async ({ name, icon, description }) => {
    const res = await fetchJSON('/api/topics/' + encodeURIComponent(slug), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: name, icon, description }) });
    // df_d6970c76 Fix 2: fetchJSON returns null on 4xx/5xx (utils.js:93 keeps
    // 404 silent on purpose). Without this guard the cb unconditionally
    // reloads labels and re-renders the old name, producing a silent revert
    // with zero user feedback. Surface the failure so the user knows to retry.
    if (!res) { showToast('Could not save the new name. Please try again.'); return; }
    await reloadLabelsAndConvs();
    // Active-state cosmetic: if the renamed label was selected, bring the
    // selected name in sync so renderLabels keeps the highlight. Not part of
    // persistence — kept out of the spec assertions to avoid coupling.
    if (selectedLabel && (selectedLabel === label?.name || selectedLabel === cur)) {
      setSelectedLabel(name);
    }
  });
}

export function removeLabel(context) {
  const target = String(context || '').trim();
  const label = labels.find(l => [l.slug, l.context, l.name].filter(Boolean).includes(target));
  const slug = label?.slug || label?.context || target;
  if (!slug) { showToast('Could not find that topic.'); return; }
  showConfirmModal('Remove Topic', 'Conversations will be untagged.', 'Remove', true, async () => {
    const res = await fetchJSON('/api/topics/' + encodeURIComponent(slug), { method: 'DELETE' });
    if (!res) { showToast('Could not remove that topic. Please try again.'); return; }
    if (label && selectedLabel === label.name) setSelectedLabel(null);
    await reloadLabelsAndConvs();
  });
}

function openLabelContextMenu(e, label) {
  e.preventDefault(); e.stopPropagation();
  const m = $('#contextMenu');
  m.style.left = (e.clientX + 220 > innerWidth ? e.clientX - 220 : e.clientX) + 'px';
  m.style.top = (e.clientY + 200 > innerHeight ? e.clientY - 200 : e.clientY) + 'px';
  m.classList.add('open');
  // df_d6970c76 Fix 2: prefer the canonical .slug, falling back to legacy
  // .context, and only resort to label.name if both are absent. Without this,
  // a stale-shape label (missing .slug/.context) would fall back to the human
  // name, sending a PUT to /api/topics/{name} which 404s — exactly the bug
  // pattern this defect closes on the client side.
  const labelContext = esc(label.slug || label.context || label.name);
  m.innerHTML = `<div class="context-menu-item" data-action="renameLabelAction" data-id="${label.id}" data-context="${labelContext}" data-name="${esc(label.name).replace(/"/g, '&quot;')}"><span class="material-symbols-outlined ctx-icon">edit</span> Rename</div><div class="context-menu-item danger" data-action="removeLabelAction" data-id="${label.id}" data-context="${labelContext}"><span class="material-symbols-outlined ctx-icon">delete</span> Delete</div>`;
}

// Listen for sidebar sync events
document.addEventListener('topic-changed', () => renderLabels());
document.addEventListener('conv-tags-changed', (e) => { currentConvTags = e.detail?.tags || []; renderLabels(); });
document.addEventListener('robotdojo:belt-ready', () => renderLabels());

// ─── Modals ───────────────────────────────────────────────────────

export function showConfirmModal(title, msg, btn, danger, cb) {
  $('#modalTitle').textContent = title;
  const m = $('#modalMessage'); m.textContent = msg; m.dataset.visible = msg ? 'true' : 'false';
  $('#modalInput').dataset.visible = 'false';
  const b = $('#modalConfirmBtn'); b.textContent = btn; b.className = danger ? 'danger' : 'confirm';
  setModalCallback(cb);
  b.onclick = () => { const fn = modalCallback; closeModal(); if (fn) fn(); };
  $('#robotdojoModal').classList.add('open');
}

export function showPromptModal(title, def, cb) {
  $('#modalTitle').textContent = title; $('#modalMessage').dataset.visible = 'false';
  const inp = $('#modalInput'); inp.dataset.visible = 'true'; inp.value = def || '';
  const b = $('#modalConfirmBtn'); b.textContent = 'Save'; b.className = 'confirm';
  setModalCallback(cb);
  b.onclick = () => { const fn = modalCallback, v = inp.value; closeModal(); if (fn) fn(v); };
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); b.click(); } };
  $('#robotdojoModal').classList.add('open');
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
}

export function closeModal() { $('#robotdojoModal').classList.remove('open'); setModalCallback(null); }
export function toggleHelp() { const m = $('#helpModal'); m.classList.toggle('open'); if (m.classList.contains('open')) loadHelpContent(); }
export function closeHelp() { $('#helpModal').classList.remove('open'); }

export function loadHelpContent() {
  // Model pricing has moved to the Usage page in Account settings.
}

export function openContextMenu(e, id, pinned) {
  e.preventDefault(); e.stopPropagation();
  const m = $('#contextMenu');
  // st_6360589a: Topics removed from right-click menu — the picker wrote to the
  // legacy `tags` JSON column only and never updated `conversation_topics` or
  // `topic_slug`, so it had zero effect on Layer 0 context.md / Layer 1 RAG.
  // Topic is set at chat creation (inherited from nav) and immutable per
  // 00-scope.md (existing-conversation toggle is out of scope).
  m.innerHTML = `<div class="context-menu-item" data-action="rename"><span class="material-symbols-outlined ctx-icon">edit</span> Rename</div>
<div class="context-menu-item" data-action="pin"><span class="material-symbols-outlined ctx-icon">${pinned ? 'star' : 'star_border'}</span> ${pinned ? 'Unstar' : 'Star'}</div>
<div class="context-menu-item" data-action="share"><span class="material-symbols-outlined ctx-icon">content_copy</span> Copy link</div>
<div class="context-menu-divider"></div>
<div class="context-menu-item" data-action="archive"><span class="material-symbols-outlined ctx-icon">archive</span> Archive</div>
<div class="context-menu-item danger" data-action="delete"><span class="material-symbols-outlined ctx-icon">delete</span> Delete</div>`;
  m.style.left = (e.clientX + 220 > innerWidth ? e.clientX - 220 : e.clientX) + 'px';
  m.style.top = (e.clientY + 200 > innerHeight ? e.clientY - 200 : e.clientY) + 'px';
  m.classList.add('open');
  $$('.context-menu-item', m).forEach(i => { i.onclick = () => handleCtx(i.dataset.action, id, pinned); });
}

export function closeContextMenu() { $('#contextMenu').classList.remove('open'); }

export async function handleCtx(action, id, pinned) {
  closeContextMenu();
  if (action === 'rename') showPromptModal('Rename', conversationById(id)?.title || '', async t => { if (t) await renameConversation(id, t); });
  else if (action === 'pin') { await fetchJSON('/api/conversations/' + id + '/pin', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: pinned ? 0 : 1 }) }); loadConversations(); }
  else if (action === 'share') { try { const data = await fetchJSON('/api/conversations/' + id + '/share', { method: 'POST' }); if (data?.url) { await navigator.clipboard.writeText(location.origin + data.url); showToast('Link copied'); } } catch { showToast('Failed'); } }
  else if (action === 'archive') { await fetchJSON('/api/conversations/' + id + '/archive', { method: 'POST' }); if (id === currentConvId) { setCurrentConvId(null); setMessages([]); } loadConversations(); showToast('Archived'); }
  else if (action === 'delete') showConfirmModal('Delete', 'Permanently delete this conversation?', 'Delete', true, async () => { await fetchJSON('/api/conversations/' + id, { method: 'DELETE' }); if (id === currentConvId) { setCurrentConvId(null); setMessages([]); } loadConversations(); });
}

// Detail menu (three-dot on topbar)
export async function toggleConvDetailMenu() {
  const menu = $('#convDetailMenu'); if (!menu) return;
  if (menu.classList.contains('open')) { menu.classList.remove('open'); return; }
  if (!currentConvId) return;
  const conv = cachedConvs.find(c => c.id === currentConvId);
  const isStarred = conv?.pinned;
  // st_6360589a: Topics + Copy link removed from three-dot detail menu.
  // Topics: see openContextMenu — the picker wrote only to the legacy
  // `tags` column, so it had zero effect on context.md / RAG.
  // Copy link: removed from this surface by product decision (still
  // available via the right-click context menu on the nav row).
  menu.innerHTML = `<div class="conv-detail-menu-item action-rename"><span class="material-symbols-outlined">edit</span> Rename</div><div class="conv-detail-menu-item action-star"><span class="material-symbols-outlined">${isStarred ? 'star' : 'star_border'}</span> ${isStarred ? 'Unstar' : 'Star'}</div><div class="conv-detail-menu-divider"></div><div class="conv-detail-menu-item action-archive"><span class="material-symbols-outlined">archive</span> Archive</div><div class="conv-detail-menu-item action-delete" style="color:var(--danger)"><span class="material-symbols-outlined">delete</span> Delete</div>`;
  menu.classList.add('open');
  menu.querySelector('.action-rename')?.addEventListener('click', () => { closeConvDetailMenu(); showPromptModal('Rename', conv?.title || $('#topbarTitle')?.textContent || '', async t => { if (t) await renameConversation(currentConvId, t); }); });
  menu.querySelector('.action-star')?.addEventListener('click', () => { closeConvDetailMenu(); toggleStar(currentConvId, isStarred ? 0 : 1); });
  menu.querySelector('.action-archive')?.addEventListener('click', () => { closeConvDetailMenu(); quickArchive(currentConvId).then(() => newConversation()); });
  menu.querySelector('.action-delete')?.addEventListener('click', () => { closeConvDetailMenu(); quickDelete(currentConvId); });
}

export function closeConvDetailMenu() { const menu = $('#convDetailMenu'); if (menu) menu.classList.remove('open'); }

// ─── Messages & Streaming ─────────────────────────────────────────

function truncateAttachments(text) {
  const idx = text.indexOf('\n---\nAttached files:');
  if (idx === -1) return esc(text);
  const prompt = text.slice(0, idx);
  const attachSection = text.slice(idx);
  const fileNames = [...attachSection.matchAll(/\*\*(.+?)\*\*/g)].map(m => m[1]);
  const chips = fileNames.map(n => `<span class="file-chip-inline">${esc(n)}</span>`).join('');
  return esc(prompt) + (chips ? `<div class="attached-files-summary">${chips}</div>` : '');
}

export function renderMessages() {
  $('#messagesInner').innerHTML = messages.map((m, i) => {
    if (m.role === 'system') return ''; // rendered via _toolCalls on the adjacent assistant message
    const seq = m.seq ?? i;
    if (m.role === 'user') {
      const content = truncateAttachments(m.content);
      const replyBtn = `<button class="msg-action-btn reply-btn" data-action="startThread" data-seq="${seq}" title="Reply in thread"><span class="material-symbols-outlined icon-sm">reply</span></button>`;
      const msgActions = `<span class="msg-actions">${replyBtn}</span>`;
      const threadContainer = `<div class="thread-container" id="thread-${seq}"><div class="thread-replies" id="threadReplies-${seq}"></div><div class="thread-input-wrap"><textarea class="thread-input-field" placeholder="Reply in thread..." rows="1" data-seq="${seq}"></textarea><button class="thread-send" data-action="sendThreadReply" data-seq="${seq}"><span class="material-symbols-outlined icon-sm">send</span></button></div></div>`;
      return `<div class="message user" data-idx="${i}" data-seq="${seq}" data-ctx-idx="${i}"><div class="role">You</div><div class="content">${content}</div><div class="msg-meta">${msgActions}</div></div>${threadContainer}`;
    }
    const content = renderMarkdown(m.content);
    const pipeline = m._pipeline || null;
    const indicators = pipeline ? '<div class="pipeline-row">' + renderPipelineDots(pipeline) + '</div>' : '';
    const toolTrace = m._toolCalls?.length ? renderToolTrace(m._toolCalls) : '';
    const replyBtn = `<button class="msg-action-btn reply-btn" data-action="startThread" data-seq="${seq}" title="Reply in thread"><span class="material-symbols-outlined icon-sm">reply</span></button>`;
    const msgActions = `<span class="msg-actions">${replyBtn}</span>`;
    const threadContainer = `<div class="thread-container" id="thread-${seq}"><div class="thread-replies" id="threadReplies-${seq}"></div><div class="thread-input-wrap"><textarea class="thread-input-field" placeholder="Reply in thread..." rows="1" data-seq="${seq}"></textarea><button class="thread-send" data-action="sendThreadReply" data-seq="${seq}"><span class="material-symbols-outlined icon-sm">send</span></button></div></div>`;
    return `<div class="message assistant" data-idx="${i}" data-seq="${seq}" data-ctx-idx="${i}"><div class="role"><img src="/static/favicon.svg" alt="" style="width:1em;height:1em;vertical-align:-0.15em"> Miyagi</div><div class="content">${content}</div>${indicators}${toolTrace}<div class="msg-meta">${msgActions}</div></div>${threadContainer}`;
  }).join('');
  addCopyButtons();
  const container = $('#messages');
  scrollToBottom(container);
  requestAnimationFrame(() => scrollToBottom(container));
  setTimeout(() => scrollToBottom(container), 300);
}

export function startThread(seq) {
  const container = $('#thread-' + seq);
  if (!container) return;
  const isOpen = container.dataset.visible === 'true';
  container.dataset.visible = isOpen ? 'false' : 'true';
  if (!isOpen) {
    // Load existing thread replies
    openThread(seq);
    const ta = container.querySelector('.thread-input-field');
    if (ta) setTimeout(() => ta.focus(), 50);
  }
}

async function openThread(seq) {
  if (!currentConvId) return;
  const repliesEl = $('#threadReplies-' + seq);
  if (!repliesEl) return;
  try {
    const data = await fetchJSON('/api/conversations/' + currentConvId + '/threads/' + seq);
    if (!data || !data.messages) { repliesEl.innerHTML = '<div class="thread-empty">No replies yet.</div>'; return; }
    repliesEl.innerHTML = data.messages.map(m => {
      const isUser = m.role === 'user';
      const roleLabel = isUser ? 'You' : '<img src="/static/favicon.svg" alt="" style="width:1em;height:1em;vertical-align:-0.15em"> Miyagi';
      const content = isUser ? esc(m.content) : renderMarkdown(m.content);
      return `<div class="message ${isUser ? 'user' : 'assistant'}"><div class="role">${roleLabel}</div><div class="content">${content}</div></div>`;
    }).join('');
  } catch (err) {
    repliesEl.innerHTML = '<div class="thread-empty">Could not load replies.</div>';
    console.warn('[thread] load failed:', err.message);
  }
}

export async function sendThreadReply(seq) {
  if (!currentConvId) return;
  const ta = $(`.thread-input-field[data-seq="${seq}"]`);
  if (!ta) return;
  const text = ta.value.trim();
  if (!text) return;
  ta.value = ''; ta.style.height = 'auto';
  const repliesEl = $('#threadReplies-' + seq);
  if (repliesEl) {
    const userDiv = document.createElement('div');
    userDiv.className = 'message user';
    userDiv.innerHTML = `<div class="role">You</div><div class="content">${esc(text)}</div>`;
    repliesEl.appendChild(userDiv);
    const aiDiv = document.createElement('div');
    aiDiv.className = 'message assistant';
    aiDiv.innerHTML = '<div class="role"><img src="/static/favicon.svg" alt="" style="width:1em;height:1em;vertical-align:-0.15em"> Miyagi</div><div class="content streaming-cursor"></div>';
    repliesEl.appendChild(aiDiv);
    const contentDiv = aiDiv.querySelector('.content');
    try {
      const res = await fetch('/api/conversations/' + currentConvId + '/threads/' + seq, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }),
      });
      if (!res.ok) { contentDiv.textContent = 'Error: ' + res.status; contentDiv.classList.remove('streaming-cursor'); return; }
      const reader = res.body.getReader(), decoder = new TextDecoder(); let buffer = '', fullText = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const d = JSON.parse(line.slice(5).trim());
          if (d.type === 'delta') { fullText += d.text; contentDiv.innerHTML = renderMarkdown(fullText); contentDiv.classList.add('streaming-cursor'); }
          else if (d.type === 'done') { contentDiv.classList.remove('streaming-cursor'); }
        }
      }
      contentDiv.classList.remove('streaming-cursor');
      addCopyButtons();
    } catch (err) {
      contentDiv.textContent = 'Failed to send reply.';
      contentDiv.classList.remove('streaming-cursor');
    }
  }
}

export function editMessage(idx) {
  const t = messages[idx].content;
  setMessages(messages.slice(0, idx));
  renderMessages();
  const ta = $('.chat-input'); if (ta) { ta.value = t; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'; ta.focus(); }
  const sb = $('.send-circle'); if (sb) sb.disabled = false;
}

export function deleteMessage(idx) {
  if (idx < 0 || idx >= messages.length) return;
  setMessages(messages.slice(0, idx));
  renderMessages();
  if (currentConvId) {
    fetchJSON('/api/conversations/' + currentConvId + '/messages', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
  }
  showToast('Message deleted');
}

export function showMsgContextMenu(event, idx) {
  event.preventDefault();
  const menu = document.createElement('div');
  menu.className = 'context-menu open';
  menu.style.left = (event.clientX + 220 > innerWidth ? event.clientX - 220 : event.clientX) + 'px';
  menu.style.top = (event.clientY + 150 > innerHeight ? event.clientY - 150 : event.clientY) + 'px';
  menu.innerHTML = `<div class="context-menu-item" data-action="deleteMessageAndClose" data-idx="${idx}"><span class="material-symbols-outlined icon-sm">delete</span> Delete message</div><div class="context-menu-item" data-action="editMessageAndClose" data-idx="${idx}"><span class="material-symbols-outlined icon-sm">edit</span> Edit from here</div>`;
  document.body.appendChild(menu);
  const close = () => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}

// ─── Tool Trace ───────────────────────────────────────────────────

function parseToolsUsed(content) {
  if (!content?.startsWith('[Tools used:')) return null;
  const inner = content.slice('[Tools used: '.length, -1);
  const results = [];
  // Match: toolName({...partial-json})
  const re = /([a-zA-Z_][a-zA-Z0-9_]*)\(\{([^)]*)\)/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const name = m[1];
    const argsPartial = m[2];
    let label = '';
    // Try priority keys: query, name, label, topic_slug, to, title, id
    for (const key of ['query', 'name', 'label', 'topic_slug', 'to', 'title', 'id']) {
      const kv = new RegExp(`"${key}"\\s*:\\s*"([^"]{1,80})"`).exec(argsPartial);
      if (kv) { label = kv[1]; break; }
    }
    results.push({ name, label });
  }
  return results.length ? results : null;
}

const TOOL_LIVE_PHRASES = {
  search_memory: 'searching memory',
  search_emails: 'searching emails',
  search_contacts: 'looking up contacts',
  search_people: 'looking up people',
  get_health_summary: 'checking health data',
  get_calendar_events: 'checking calendar',
  read_identity_section: 'reading identity',
  update_identity_section: 'updating identity',
  section_history: 'reading identity history',
  get_rag_context: 'searching your data',
  create_topic: 'creating topic',
  update_topic: 'updating topic',
  delete_topic: 'deleting topic',
  list_topics: 'listing topics',
  get_telemetry: 'checking usage',
  get_wiki_page: 'reading context',
  update_context: 'updating context',
  distill_identity: 'distilling identity',
  add_fact: 'adding fact',
  add_person: 'adding person',
  update_person: 'updating person',
  enrich_from_linkedin: 'enriching profile',
  log_health_note: 'logging health note',
  log_medication: 'logging medication',
  log_metric: 'logging metric',
  run_import: 'importing data',
  connect_account: 'connecting account',
  list_integrations: 'checking integrations',
  apply_voice: 'applying voice',
  list_voices: 'listing voices',
  get_preferences: 'reading preferences',
  set_preference: 'updating preferences',
  update_profile: 'updating profile',
  update_soul: 'updating soul',
  request_credential: 'requesting credential',
  run_identity_export: 'exporting identity',
  list_export_targets: 'listing export targets',
  set_export_target: 'setting export target',
  set_telemetry: 'configuring telemetry',
  set_release_channel: 'setting release channel',
  set_beta_opt_in: 'setting beta opt-in',
  list_beta_opt_ins: 'listing beta opt-ins',
  submit_feature_request: 'submitting feature request',
  list_my_feature_requests: 'listing feature requests',
  check_for_updates: 'checking for updates',
  get_device_name: 'getting device name',
  rename_device: 'renaming device',
  confirm_device_name: 'confirming device name',
  delete_my_account: 'processing account deletion',
  delete_my_data: 'processing data deletion',
  cancel_my_subscription: 'cancelling subscription',
};

function liveThinkingPhrase(name, label) {
  const base = TOOL_LIVE_PHRASES[name] || name.replace(/_/g, ' ');
  return label ? `${base} for "${label}"` : base;
}

function toolPhrase(name, label) {
  const pretty = name.replace(/_/g, ' ');
  const labelHtml = label ? ` <span class="tool-arg">"${esc(label)}"</span>` : '';
  return `${esc(pretty)}${labelHtml}`;
}

function renderToolTrace(tools) {
  if (!tools?.length) return '';
  const count = tools.length;
  const summary = count === 1 ? '1 tool used' : `${count} tools used`;
  const capped = tools.slice(0, 5);
  const steps = capped.map(t => `↳ ${toolPhrase(t.name, t.label)}`);
  if (count > 5) steps.push(`+${count - 5} more`);
  if (window.RobotDojoComponents?.toolTrace) return window.RobotDojoComponents.toolTrace({ summary, steps });
  return `<div class="tool-trace"><div class="thinking-summary" data-action="toggleThinking">${esc(summary)} <span class="thinking-chevron">▸</span></div><div class="thinking-steps" hidden>${steps.map(step => `<div class="tool-step">${step}</div>`).join('')}</div></div>`;
}

// ─── Live indicator state (st_74f45a1a Phase 4) ────────────────────
// The 5-dot pipeline was replaced by a single value-surfacing indicator
// driven by server-emitted `phase` events. `state.pipeline` is still
// tracked internally for the finalizeSend trace summary (tokens, tool
// count, etc.) but no longer rendered into the DOM as colored dots.

function updateLivePipeline(_state) {
  // No-op — the previous implementation rendered colored dots from
  // state.pipeline. The new indicator subscribes to `phase` events
  // directly via state.indicator.setPhase() in handleSSEEvent. Kept as a
  // function (vs deletion) so the dozens of call sites stay valid during
  // the transition.
}

function updateLiveToolTrace(state) {
  if (!state.toolCalls.length) return;
  const ttftEl = state.msgDiv?.querySelector('.ttft-progress');
  if (!ttftEl) return;
  const lastTool = state.toolCalls[state.toolCalls.length - 1];
  const phrase = liveThinkingPhrase(lastTool.name, lastTool.label);
  const wasExpanded = ttftEl.querySelector('.thinking-steps') && !ttftEl.querySelector('.thinking-steps[hidden]');
  const chevron = wasExpanded ? '▾' : '▸';
  const capped = state.toolCalls.slice(0, 5);
  const overflow = state.toolCalls.length > 5 ? `<div class="tool-step">+${state.toolCalls.length - 5} more</div>` : '';
  const steps = capped.map(t =>
    `<div class="tool-step">↳ ${toolPhrase(t.name, t.label)}</div>`
  ).join('') + overflow;
  ttftEl.innerHTML = `<div class="thinking-summary" data-action="toggleThinking">${esc(phrase)} <span class="thinking-chevron">${chevron}</span></div><div class="thinking-steps"${wasExpanded ? '' : ' hidden'}>${steps}</div>`;
  ttftEl.classList.add('live-thinking-visible');
}

function showTransientPrelude(state, text = CLIENT_PRELUDE_TEXT) {
  if (!state || state.fullContent || state.preludeActive) return;
  // The per-turn indicator already owns wait-state copy. Writing the same
  // line into the bubble is the duplicated spinner/status.
  if (state.indicator) {
    if (!state.indicator._lastPhase || state.indicator._lastPhase === 'connected' || state.indicator._lastPhase === 'thinking') {
      state.indicator.setPhase('thinking', { label: text });
    }
    return;
  }
  state.preludeActive = true;
  state.contentDiv.textContent = text;
  state.contentDiv.classList.add('streaming-cursor', 'transient-prelude');
}

function clearTransientPrelude(state) {
  if (!state) return;
  if (state.preludeTimer) {
    clearTimeout(state.preludeTimer);
    state.preludeTimer = null;
  }
  if (!state.preludeActive) return;
  state.preludeActive = false;
  state.contentDiv.textContent = '';
  state.contentDiv.classList.remove('transient-prelude');
}

function startClientPreludeTimer(state) {
  if (!state || state.preludeTimer) return;
  if (state.indicator) return;
  state.preludeTimer = setTimeout(() => showTransientPrelude(state), CLIENT_PRELUDE_MS);
}

// ─── SSE Stream Handler ───────────────────────────────────────────

function handleSSEEvent(d, state) {
  // Ambient events (drop-folder file_*, secure_input) piggyback on the chat
  // stream. Dispatch them to the global chat event bus; the components
  // registered in app.js (drop-events, secure-input-overlay) consume them.
  // Keep the main switch focused on per-message pipeline state.
  if (d && typeof d.type === 'string' &&
      (d.type === 'file_arrived' || d.type === 'file_classified' ||
       d.type === 'file_processed' || d.type === 'file_errored' ||
       d.type === 'secure_input' || d.type === 'entity_recognized')) {
    try { window.__chatEventBus?.dispatch?.(d); } catch {}
    return;
  }
  const { contentDiv, container } = state;
  if (d.type === 'status') {
    state.pipeline.connected = 'ok';
    if (!d.hasRAG) state.pipeline.rag = 'skip';
    // Capture pipeline metadata for detail row
    if (d.toolCount != null) state.statusToolCount = d.toolCount;
    if (d.belt) state.statusBelt = d.belt;
    updateLivePipeline(state);
  } else if (d.type === 'phase') {
    // Server lifecycle event (st_74f45a1a) — drive the single indicator.
    // R2 Phase 1D: phase frames may carry {count, label} payload — forward
    // verbatim so the indicator can render real numbers like
    // "Searching 12 notes about Sarah" instead of generic placeholders.
    if (state.indicator && d.name) {
      const payload = {};
      if (typeof d.count === 'number') payload.count = d.count;
      if (typeof d.label === 'string') payload.label = d.label;
      // st_b57e6ec5 — server-signaled provider-health note (lib/provider-health.js
      // via routes/chat.js). Never invented client-side; forwarded verbatim so
      // the indicator can render the honest "AI service is slow" note.
      if (d.degraded === true) payload.degraded = true;
      for (const key of ['mode', 'lane', 'model', 'modelId', 'targetTtftMs']) {
        if (d[key] != null) payload[key] = d[key];
      }
      if (payload.model && !payload.modelName) {
        const resolved = models.find(m => m.key === payload.model);
        if (resolved?.name) payload.modelName = resolved.name;
      }
      state.indicator.setPhase(d.name, Object.keys(payload).length ? payload : undefined);
    }
  } else if (d.type === 'conv_saved') {
    state.pipeline.persisted = d.ok ? 'ok' : 'fail'; updateLivePipeline(state);
  } else if (d.type === 'thinking') {
    state.isThinking = true; state.thinkingContent += d.text;
  } else if (d.type === 'prelude') {
    // Status belongs in the indicator. Do not also paint it into the bubble.
    if (state.indicator) {
      if (!state.indicator._lastPhase || state.indicator._lastPhase === 'connected' || state.indicator._lastPhase === 'thinking') {
        state.indicator.setPhase('thinking', { label: d.text || CLIENT_PRELUDE_TEXT });
      }
      return;
    }
    showTransientPrelude(state, d.text || CLIENT_PRELUDE_TEXT);
  } else if (d.type === 'delta') {
    if (state.isThinking) state.isThinking = false;
    clearTransientPrelude(state);
    if (!state.pipeline.response) {
      // Tools are done — first delta means streaming has started
      state.pipeline.tools = state.toolCalls.length ? 'ok' : 'skip';
      state.pipeline.response = 'pending';
      updateLivePipeline(state);
      // Hide the live thinking indicator; finalizeSend will restore it as permanent trace
      const ttftEl = state.msgDiv?.querySelector('.ttft-progress');
      if (ttftEl) ttftEl.classList.remove('live-thinking-visible');
      // st_74f45a1a R2 Phase 1D — dissolve indicator into the streamed text.
      // CSS .chat-indicator { transition: opacity 0.2s ease-out } animates.
      if (state.indicator) state.indicator.fadeOut();
    }
    if (state.deltaBuffer) {
      state.deltaBuffer.push(d.text);
      if (typeof state.flushDeltaBuffer === 'function') state.flushDeltaBuffer(false);
    } else {
      state.fullContent += d.text; state.scheduleRender();
    }
  } else if (d.type === 'tool_start') {
    // Extract short label from args for display
    let label = '';
    for (const key of ['query', 'name', 'label', 'topic_slug', 'to', 'title', 'id']) {
      const v = d.args?.[key];
      if (typeof v === 'string' && v.length < 80) { label = v; break; }
    }
    state.toolCalls.push({ name: d.name, label });
    state.pipeline.tools = 'pending';
    updateLiveToolTrace(state);
  } else if (d.type === 'tool_call') {
    state.fullContent += `\n\n> *${d.name.replace(/_/g, ' ')}*...\n\n`; state.scheduleRender();
  } else if (d.type === 'tool_result') {
    state.fullContent += `> ${d.preview}\n\n`; state.scheduleRender();
  } else if (d.type === 'rag_meta') {
    state.pipeline.rag = 'ok';
    state.pipeline.ragDetail = `${(d.tokens / 1000).toFixed(1)}K tokens`;
    updateLivePipeline(state);
  } else if (d.type === 'done') {
    // R2 Phase 1D — force-flush any remaining buffered deltas before paint.
    if (typeof state.flushDeltaBuffer === 'function') state.flushDeltaBuffer(true);
    state.lastUsage = d.usage; state.costCents = d.cost_cents;
    state.pipeline.response = 'ok';
    const totalTokens = (d.usage.input_tokens || 0) + (d.usage.output_tokens || 0);
    const toolCount = state.statusToolCount != null ? state.statusToolCount : (state.toolCalls?.length || 0);
    const belt = state.statusBelt || window._currentBelt || '';
    const beltLabel = belt ? ` · ${belt} belt` : '';
    state.pipeline.responseDetail = `${totalTokens} tokens · ${toolCount} tools available${beltLabel}`;
    if (state.indicator) state.indicator.clear();
    cancelAnimationFrame(state.rafId); contentDiv.classList.remove('streaming-cursor'); updateUsage();
  } else if (d.type === 'error') {
    // In-stream server error frame (st_74f45a1a AC 3) — surface via ErrorUI
    // testids so the Playwright retry spec can find chat-retry-button.
    const friendly = (d.message && d.message.length < 200)
      ? d.message
      : 'The model had trouble responding. Please try again in a moment.';
    if (!state.pipeline.response || state.pipeline.response === 'pending') {
      if (state.toolCalls.length) state.pipeline.tools = 'fail';
      state.pipeline.response = 'fail';
      state.pipeline.responseError = friendly;
    }
    cancelAnimationFrame(state.rafId);
    contentDiv.textContent = '';
    contentDiv.classList.remove('streaming-cursor');
    state.msgDiv.classList.add('error');
    if (state.indicator) state.indicator.clear();
    // ensureErrorUI() lives in the doSend closure; reach it through state.
    if (typeof state.ensureErrorUI === 'function') {
      state.ensureErrorUI().show('simulated_error', friendly);
    }
  }
}

async function executeActionInBackground(cmd, label, cardEl) {
  const btn = cardEl.querySelector('.action-hint-do');
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const conv = await fetchJSON('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: label, chat_type: 'action' }) });
    const res = await fetch('/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: cmd }], conversationId: conv.id, model: selectedModel, thinking: 'low' }) });
    if (res.ok && res.body) {
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n'); buf = lines.pop();
        for (const line of lines) { if (!line.startsWith('data: ')) continue; try { const d = JSON.parse(line.slice(6)); if (d.type === 'done') break; } catch {} }
      }
    }
    await fetchJSON('/api/conversations/' + conv.id + '/action', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed', summary: label }) });
    cardEl.innerHTML = `<span class="material-symbols-outlined action-hint-icon">check_circle</span><span class="action-hint-label">Done — ${esc(label)}</span>`;
    cardEl.classList.add('action-hint-done');
    if (selectedLabel === 'actions') loadConversations();
  } catch {
    if (btn) { btn.textContent = 'Do it'; btn.disabled = false; }
    showToast('Action failed — try again');
  }
}

function injectActionCard(contentDiv, fullContent) {
  const match = fullContent.match(/\[ACTION\]([\s\S]*?)\[\/ACTION\]/);
  if (!match) return fullContent;
  let action;
  try { action = JSON.parse(match[1]); } catch { return fullContent; }
  if (!action.cmd || !action.label) return fullContent;
  const clean = fullContent.replace(/\[ACTION\][\s\S]*?\[\/ACTION\]/, '').trim();
  contentDiv.innerHTML = renderMarkdown(clean);
  const card = document.createElement('div');
  card.className = 'action-hint-card';
  card.innerHTML = `<span class="material-symbols-outlined action-hint-icon">bolt</span><span class="action-hint-label">${esc(action.label)}</span><div class="action-hint-btns"><button class="action-hint-do">Do it</button><button class="action-hint-dismiss" title="Dismiss">×</button></div>`;
  card.querySelector('.action-hint-do').addEventListener('click', () => executeActionInBackground(action.cmd, action.label, card));
  card.querySelector('.action-hint-dismiss').addEventListener('click', () => card.remove());
  contentDiv.after(card);
  return clean;
}

function finalizeSend(state) {
  const { msgDiv, contentDiv, container } = state;
  clearTransientPrelude(state);
  const clean = injectActionCard(contentDiv, state.fullContent);
  const am = { role: 'assistant', content: clean, _pipeline: state.pipeline, _toolCalls: state.toolCalls.length ? state.toolCalls : undefined };
  if (state.lastUsage) am.tokens = state.lastUsage.output_tokens;
  messages.push(am);
  if (clean === state.fullContent) contentDiv.innerHTML = renderMarkdown(state.fullContent);
  contentDiv.classList.remove('streaming-cursor');
  if (state.costCents > 0) addConversationCost(state.costCents);
  const p = state.pipeline;
  if (!p.rag) p.rag = 'skip';
  if (!p.tools) p.tools = 'skip';
  if (!p.response) p.response = 'pending';
  // Transition .ttft-progress from live thinking indicator to permanent "N tools used" trace
  const ttftEl = msgDiv?.querySelector('.ttft-progress');
  if (ttftEl && state.toolCalls.length) {
    const count = state.toolCalls.length;
    const capped = state.toolCalls.slice(0, 5);
    const overflow = count > 5 ? `<div class="tool-step">+${count - 5} more</div>` : '';
    const steps = capped.map(t => `<div class="tool-step">↳ ${toolPhrase(t.name, t.label)}</div>`).join('') + overflow;
    const summary = count === 1 ? '1 tool used' : `${count} tools used`;
    ttftEl.innerHTML = `<div class="thinking-summary" data-action="toggleThinking">${esc(summary)} <span class="thinking-chevron">▸</span></div><div class="thinking-steps" hidden>${steps}</div>`;
    ttftEl.classList.add('live-thinking-visible');
  } else if (ttftEl) {
    ttftEl.classList.remove('live-thinking-visible');
  }
  addCopyButtons(); scrollToBottom(container);
  if (messages.length === 2) {
    $('#topbarTitle').textContent = messages[0].content.slice(0, 50);
    // st_6360589a: secondary PATCH /tags removed — upsertConversation() now
    // writes `tags=[name]` inline at INSERT on the chat-stream call, so the
    // first turn's create+tag is a single SQL transaction. No browser-side
    // tag write needed; no race window where the chat is briefly missing
    // from its topic's filtered view in the nav.
    setTimeout(async () => { const c = await fetchJSON('/api/conversations/' + currentConvId); if (c?.title) $('#topbarTitle').textContent = c.title; await reloadLabelsAndConvs(); }, 3000);
  } else { setTimeout(() => reloadLabelsAndConvs(), 2000); }
}

// ─── Compression Prompt ──────────────────────────────────────────

const COMPRESSION_THRESHOLD = 12;
const COMPRESSION_DISMISS_KEY = 'rdj_compressed_convs';

function showCompressionBanner(convId) {
  // Remove any existing banner
  $$('.compression-banner').forEach(el => el.remove());
  const inputArea = $('#inputArea');
  if (!inputArea) return;
  const banner = document.createElement('div');
  banner.className = 'compression-banner';
  banner.innerHTML = `<span>This conversation is getting long. Compress older messages to free context?</span><button class="compression-banner-btn primary">Compress</button><button class="compression-banner-btn">Dismiss</button>`;
  inputArea.parentNode.insertBefore(banner, inputArea);
  banner.querySelector('.compression-banner-btn.primary').onclick = async () => {
    banner.remove();
    try {
      const res = await fetch('/api/conversations/' + convId + '/compress', { method: 'POST' });
      if (res.ok) { showToast('Compressed'); await loadConversation(convId); }
      else showToast('Compression failed');
    } catch (err) { showToast('Compression failed'); }
  };
  banner.querySelector('.compression-banner-btn:not(.primary)').onclick = () => {
    banner.remove();
    const dismissed = JSON.parse(localStorage.getItem(COMPRESSION_DISMISS_KEY) || '[]');
    dismissed.push(convId);
    localStorage.setItem(COMPRESSION_DISMISS_KEY, JSON.stringify(dismissed));
  };
}

function maybeShowCompressionPrompt(convId) {
  const dismissed = JSON.parse(localStorage.getItem(COMPRESSION_DISMISS_KEY) || '[]');
  if (messages.length > COMPRESSION_THRESHOLD && !dismissed.includes(convId)) {
    showCompressionBanner(convId);
  }
}

export function isRobotDojoMemoryImport(text) {
  const body = String(text || '');
  return /^#\s*Robot Dojo Memory Import\b/im.test(body)
    || /\bRobot Dojo Memory Import\b/i.test(body)
    || /\bidentity and memory import\b/i.test(body);
}

export function isProfileImportModeMemoryPaste(text) {
  const body = String(text || '').trim();
  if (!body || body.length < 800) return false;
  if (typeof window === 'undefined' || !window.robotdojoProfileImportMode) return false;
  return !/^Start the Robot Dojo memory import workflow\b/i.test(body);
}

export function buildMemoryImportWorkflowPrompt(dump) {
  return `Start the Robot Dojo memory import workflow.

The user pasted an identity dump from another AI. It has already been ingested as a high-weight source on the timeline and memory log. Do not treat this as a normal chat message.

Your job now is to confirm with the user:
1. Summarize the durable facts, preferences, context, and how they want an AI to behave.
2. Flag contradictions, stale claims, sensitive facts, and anything that should not stand without explicit approval.
3. Ask concise clarifying questions only where the import is inconsistent or high-impact. Do not interview.
4. After they confirm, update identity via update_identity_section for approved timeless facts. Time-bounded facts belong in topic context.
5. Do not invent. Do not write unconfirmed claims as settled.

Imported dump:

${dump}`;
}

export async function doSend(textarea, sendBtn) {
  let text = textarea.value.trim();
  if (!text || sending) return;
  if (window.robotdojoEditMode && /^FINAL MARKDOWN\s*\n/i.test(text)) {
    const content = text.replace(/^FINAL MARKDOWN\s*\n/i, '');
    const target = window.robotdojoEditMode.target;
    try {
      const res = await fetch(`/api/accounts/edit-targets/${encodeURIComponent(target)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (res.ok) {
        showToast('Markdown saved');
        textarea.value = '';
        textarea.style.height = 'auto';
        return;
      }
      showToast('Save failed');
    } catch {
      showToast('Save failed');
    }
    return;
  }
  const rawDump = text;
  const isIdentityDump = isRobotDojoMemoryImport(text) || isProfileImportModeMemoryPaste(text);
  if (attachedFiles.some(f => f.uploading)) { showToast('Files still uploading...'); return; }
  if (messages.length === 0) {
    if (!currentConvId) setCurrentConvId(crypto.randomUUID());
    window.robotdojoContext = { type: 'conversation', id: currentConvId };
    showChatView();
    if (window._lockedTopicSlug) {
      history.replaceState(null, '', liveTopicPath(window._lockedTopicSlug));
    } else {
      history.replaceState(null, '', chatBasePath() + '/' + currentConvId);
    }
  }
  if (isIdentityDump) {
    try {
      const res = await fetch('/api/accounts/seed-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ text: rawDump, conversationId: currentConvId }),
      });
      if (!res.ok) showToast('Could not save the dump to memory yet — still reading it with you');
    } catch {
      showToast('Could not save the dump to memory yet — still reading it with you');
    }
  }
  // Attach files to text
  const ready = attachedFiles.filter(f => !f.uploading);
  const texts = ready.filter(f => !f.fileId);
  if (texts.length) text += '\n\n---\nAttached files:\n' + texts.map(f => '**' + f.name + ':**\n```\n' + f.content + '\n```').join('\n\n');
  const files = ready.filter(f => f.fileId && f.mimeType).map(f => ({ name: f.name, fileId: f.fileId, mimeType: f.mimeType }));
  setAttachedFiles([]); renderFileChips();
  messages.push({ role: 'user', content: text });
  textarea.value = ''; textarea.style.height = 'auto'; sendBtn.disabled = true; setSending(true);
  const inner = $('#messagesInner'), container = $('#messages');
  const userDiv = document.createElement('div'); userDiv.className = 'message user';
  userDiv.innerHTML = `<div class="role">You</div><div class="content">${truncateAttachments(text)}</div>`;
  inner.appendChild(userDiv);
  requestAnimationFrame(() => scrollToBottom(container));

  const msgDiv = document.createElement('div');
  msgDiv.className = 'message assistant';
  // data-testid hooks (st_74f45a1a Phase 4) — Playwright critical-path suite.
  // chat-indicator: value-surfacing tier icon + narration (replaces the
  // 5-dot pipeline, then the single ASCII robot). The icon (ask/work/think)
  // and text slots are static markup here; Indicator (indicator.js) drives
  // their content per turn — it never builds DOM, only fills these slots.
  // assistant-message: the content bubble used for first-token assertions.
  // chat-error-container: where ErrorUI mounts its message + retry button.
  msgDiv.innerHTML = '<div class="role"><img src="/static/favicon.svg" alt="" style="width:1em;height:1em;vertical-align:-0.15em"> Miyagi</div><div class="ttft-progress"></div><div class="chat-indicator" data-testid="chat-indicator"><span class="chat-indicator-icon" data-testid="chat-indicator-icon" aria-hidden="true"></span><span class="chat-indicator-text" data-testid="chat-indicator-text"></span></div><div class="content streaming-cursor" data-testid="assistant-message"></div><div class="chat-error-container"></div>';
  inner.appendChild(msgDiv);
  const contentDiv = $('.content', msgDiv);
  // Single value-surfacing indicator — replaces the 5-dot row. State machine
  // is in apps/chat/modules/indicator.js and consumes `phase` SSE events.
  const indicatorEl = $('.chat-indicator', msgDiv);
  const errorContainerEl = $('.chat-error-container', msgDiv);
  const indicator = new Indicator(indicatorEl);
  // ErrorUI is constructed lazily on the first error so we don't render an
  // empty container in the happy path. Wired to dispatch a fresh retry by
  // simulating a click on sendBtn after restoring the original text.
  let errorUI = null;
  const ensureErrorUI = () => {
    if (!errorUI) {
      errorUI = new ErrorUI(errorContainerEl, {
        onRetry: () => {
          // Restore the failed user message text + remove the failed assistant
          // bubble, then re-send. Mirrors the prior inline retry button behavior.
          msgDiv.remove();
          // Walk back: drop the assistant placeholder if added, then the user.
          const prior = messages[messages.length - 1];
          if (prior && prior.role === 'user') {
            textarea.value = messages.pop().content;
          }
          sendBtn.disabled = !textarea.value.trim();
          if (!sendBtn.disabled) sendBtn.click();
        },
        document: window.document,
      });
    }
    return errorUI;
  };
  scrollToBottom(container);
  setAbortController(new AbortController());

  // Priority: locked topic (conversation was started in a topic) > nav selection > 'general'.
  // WHY: once a conversation is opened in a Health topic, every subsequent message
  // should inject Health context — even if the user navigates to a different nav label.
  let labelContext = 'general';
  if (window._lockedTopicSlug) {
    // Conversation was reopened — use its original topic for context continuity.
    labelContext = window._lockedTopicSlug;
  } else if (selectedLabel && typeof selectedLabel === 'object' && selectedLabel.names) {
    labelContext = selectedLabel.names.map(name => labels.find(l => l.name === name)?.context).filter(Boolean);
    if (!labelContext.length) labelContext = 'general';
  } else if (selectedLabel && typeof selectedLabel === 'string' && !['all', 'recent', 'starred'].includes(selectedLabel)) {
    labelContext = labels.find(l => l.name === selectedLabel)?.context || 'general';
  }
  const outboundMessages = isIdentityDump
    ? messages.map((m, i) => (i === messages.length - 1
      ? { ...m, content: buildMemoryImportWorkflowPrompt(rawDump) }
      : m))
    : messages;
  const body = { messages: outboundMessages, model: selectedModel, conversationId: currentConvId, thinking: thinkingLevel, context: labelContext, mode: chatMode };
  if (files.length) body.files = files;
  if (urlContext) { body.injectedContext = urlContext; setUrlContext(null); }
  // Auto-classify as action chat: shortcut-opened chat OR first message addresses @agentname specifically
  const startsWithAgent = text.trimStart().toLowerCase().startsWith('@' + agentName.toLowerCase());
  if (messages.length === 1 && (pendingActionChat || startsWithAgent || window.robotdojoProfileImportMode)) {
    body.chat_type = 'action';
    setPendingActionChat(false);
  }

  // deltaBuffer (st_74f45a1a R2 Phase 1D) — word-boundary / 80ms flush.
  // Eliminates char-by-char render jitter without delaying perceived speed:
  // a typical Anthropic stream produces ~60 deltas/sec mid-stream, many of
  // them sub-word fragments. Buffering until a whitespace boundary OR 80 ms
  // since the last flush coalesces them into chunks the eye actually parses.
  // Buffer is bypassed during retries (state.deltaBuffer set to null) so
  // partial-content recovery still paints immediately.
  const state = {
    fullContent: '', thinkingContent: '', isThinking: false, lastUsage: null, costCents: 0,
    rafId: 0, msgDiv, contentDiv, container, pipeline: {}, toolCalls: [],
    statusToolCount: null, statusBelt: null, indicator, ensureErrorUI,
    preludeActive: false, preludeTimer: null,
    deltaBuffer: [], lastDeltaFlush: 0,
  };
  let renderDirty = false;
  state.scheduleRender = () => { if (renderDirty) return; renderDirty = true; state.rafId = requestAnimationFrame(() => { renderDirty = false; const wasBottom = isNearBottom(container); if (state.fullContent) { try { contentDiv.innerHTML = renderMarkdown(state.fullContent); } catch { contentDiv.textContent = state.fullContent; } contentDiv.classList.add('streaming-cursor'); } if (wasBottom) scrollToBottom(container); }); };
  // Word-boundary flush: invoked after every delta. Concatenates the buffer
  // and paints if the trailing char is whitespace OR 80 ms elapsed since
  // the last flush.
  state.flushDeltaBuffer = (force) => {
    if (!state.deltaBuffer || !state.deltaBuffer.length) return;
    const now = Date.now();
    const joined = state.deltaBuffer.join('');
    const wordBoundary = /\s$/.test(joined);
    const aged = now - state.lastDeltaFlush > 80;
    if (force || wordBoundary || aged) {
      state.fullContent += joined;
      state.deltaBuffer = [];
      state.lastDeltaFlush = now;
      state.scheduleRender();
    }
  };

  // Auto-retry: up to 2 retries on network errors, but NOT on 4xx auth/paywall
  const MAX_RETRIES = 2;
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      clearTransientPrelude(state);
      // Reset state for retry (keep any partial content shown with a note)
      if (state.fullContent) {
        state.fullContent += '\n\n[Connection lost \u2014 retrying\u2026]';
        state.scheduleRender();
      } else {
        contentDiv.textContent = `Retrying (${attempt}/${MAX_RETRIES})\u2026`;
        contentDiv.classList.add('streaming-cursor');
      }
      state.pipeline = {}; state.toolCalls = []; state.statusToolCount = null; state.statusBelt = null;
      const ttftRetryEl = state.msgDiv?.querySelector('.ttft-progress');
      if (ttftRetryEl) { ttftRetryEl.innerHTML = ''; ttftRetryEl.classList.remove('live-thinking-visible'); }
      setAbortController(new AbortController());
      await new Promise(r => setTimeout(r, 1500 * attempt));
    }

    let timedOut = false;
    let connectTimeout = null;
    try {
      connectTimeout = setTimeout(() => { if (!state.fullContent) { timedOut = true; abortController.abort(); } }, 60000);
      let streamError = null;
      const rehydrateFromDB = async (conversationId) => {
        const conv = await fetchJSON('/api/conversations/' + conversationId);
        const rows = Array.isArray(conv?.messages) ? conv.messages : [];
        const assistant = [...rows].reverse().find(m => m?.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
        return assistant ? { assistantContent: assistant.content } : null;
      };
      startClientPreludeTimer(state);
      const streamResult = await streamChatTurn({
        body,
        authToken: (() => { try { return localStorage.getItem('robotdojo_token'); } catch { return null; } })(),
        signal: abortController.signal,
        fetch: window.fetch.bind(window),
        rehydrateFromDB,
        onEvent: (event) => handleSSEEvent(event, state),
        onStall: () => {
          timedOut = true;
          if (!state.fullContent) {
            const restoring = 'Still working. Checking for the saved answer…';
            if (state.indicator) state.indicator.setPhase('thinking', { label: restoring });
            showTransientPrelude(state, restoring);
          }
        },
        onError: (info) => { streamError = info; },
        onDone: () => {},
      });
      clearTimeout(connectTimeout);
      connectTimeout = null;
      if (streamResult?.rehydrated?.assistantContent) {
        clearTransientPrelude(state);
        if (typeof state.flushDeltaBuffer === 'function') state.flushDeltaBuffer(true);
        state.fullContent = streamResult.rehydrated.assistantContent;
        state.pipeline.response = 'ok';
        if (state.indicator) state.indicator.clear();
        cancelAnimationFrame(state.rafId);
        contentDiv.classList.remove('streaming-cursor');
        contentDiv.innerHTML = renderMarkdown(state.fullContent);
        scrollToBottom(container);
      }
      if (streamResult?.error || streamError) {
        const info = streamResult?.error || streamError;
        if (info?.error_type === 'abort_error') {
          const abortErr = new DOMException(info.message || 'The operation was aborted.', 'AbortError');
          throw abortErr;
        }
        // Handle auth + paywall + rate limit + server errors with human copy.
        if (info?.status === 401) {
          try { sessionStorage.setItem('robotdojo_login_flash', 'Sign in to continue'); } catch {}
          const here = location.pathname + location.search + location.hash;
          location.href = '/login?redirect=' + encodeURIComponent(here);
          return;
        }
        let friendly;
        if (info?.status === 402 || info?.status === 403) {
          friendly = 'This is a Black Belt feature. Check your Account status or add your issued beta key.';
        } else if (info?.status === 429) {
          friendly = 'Whoa, you\u2019re fast. Try again in 60s.';
        } else if (info?.status >= 500 || info?.error_type === 'server_error') {
          friendly = 'Something went wrong on our end. Tap Retry or try again in a moment.';
        } else if (info?.error_type === 'closed_without_done' || info?.error_type === 'stall_no_rehydrate') {
          friendly = 'The response stalled before the saved answer could be restored. Tap Retry or try again in a moment.';
        } else {
          friendly = info?.message || 'Something went wrong sending your message. Please try again.';
        }
        const err = new Error(friendly);
        err._friendly = friendly;
        err._status = info?.status || 0;
        err._errorType = info?.error_type || null;
        throw err;
      }
      finalizeSend(state);
      lastErr = null;
      // Check if we should show compression prompt
      maybeShowCompressionPrompt(currentConvId);
      break; // success — exit retry loop
    } catch (err) {
      lastErr = err;
      clearTransientPrelude(state);
      cancelAnimationFrame(state.rafId); contentDiv.classList.remove('streaming-cursor');
      if (err.name === 'AbortError') {
        // User-initiated abort — keep partial content if any
        if (state.fullContent) {
          messages.push({ role: 'assistant', content: state.fullContent });
          contentDiv.innerHTML = renderMarkdown(state.fullContent);
          addCopyButtons();
        } else if (timedOut) {
          // Timeout with no content — server stalled before responding.
          // Surface honest, retryable error via the new ErrorUI module
          // (data-testid="chat-error-message" + "chat-retry-button").
          // st_74f45a1a AC 3.
          contentDiv.textContent = '';
          if (state.indicator) state.indicator.clear();
          ensureErrorUI().show('network_error', 'Something went wrong. Please try again.');
          msgDiv.classList.add('error');
          showToast('Something went wrong. Please try again.');
        } else {
          msgDiv.remove();
        }
        break; // never retry on user abort
      }
      // 4xx errors are non-retryable (auth, paywall, rate-limit). Stream
      // stalls are also not auto-retried: the server may still be producing
      // the first answer, and a silent resend creates duplicate turns.
      const ambiguousStreamClose = err._errorType === 'stall_no_rehydrate' || err._errorType === 'closed_without_done';
      const serverExhaustedProviders = /first_delta_timeout/i.test(err.message || '');
      const isRetryable = !ambiguousStreamClose && !serverExhaustedProviders && (
        !err._status || err._status >= 500 || /network|fetch|econnr|timeout|failed to fetch/i.test(err.message)
      );
      if (isRetryable && !state.fullContent && attempt < MAX_RETRIES) {
        console.warn(`[chat] Network error, auto-retry ${attempt + 1}/${MAX_RETRIES}: ${err.message}`);
        continue;
      }
      // Final failure — surface honest, retryable error.
      const friendly = err._friendly || (navigator.onLine === false
        ? 'You\u2019re offline \u2014 reconnect and try again.'
        : 'Something went wrong sending your message. Please try again.');
      // st_74f45a1a Phase 4 — route through ErrorUI for testid hooks.
      contentDiv.textContent = '';
      if (state.indicator) state.indicator.clear();
      if (isRetryable) {
        ensureErrorUI().show('network_error', friendly);
      } else {
        // Non-retryable (auth/paywall) — render bare message with optional upgrade link.
        const noRetryMsg = document.createElement('div');
        noRetryMsg.setAttribute('data-testid', 'chat-error-message');
        noRetryMsg.className = 'chat-error-message';
        noRetryMsg.textContent = friendly;
        if (err._status === 402 || err._status === 403) {
          const a = document.createElement('a');
          a.href = '/account';
          a.textContent = ' Account';
          a.style.cssText = 'color:var(--accent);text-decoration:none;font-weight:550;margin-left:8px';
          noRetryMsg.appendChild(a);
        }
        errorContainerEl.appendChild(noRetryMsg);
      }
      msgDiv.classList.add('error');
      showToast(friendly);
      break;
    } finally {
      if (connectTimeout) clearTimeout(connectTimeout);
    }
  }
  clearTransientPrelude(state);
  setAbortController(null); setSending(false); sendBtn.disabled = !textarea.value.trim(); textarea.focus();
}

export async function updateUsage() {
  try { const res = await fetch('/api/usage/today'); if (!res.ok) return; const d = await res.json(); const c = d.cost_cents || 0; const costEl = document.getElementById('usageCost'); if (costEl) costEl.textContent = '$' + (c / 100).toFixed(2); const dotEl = document.getElementById('usageDot'); if (dotEl) dotEl.className = 'usage-dot' + (c > 500 ? ' danger' : c > 100 ? ' warn' : ''); } catch {}
}

// ─── Import bridge for input.js ───────────────────────────────────
// input.js needs buildInputBox and bindInputEvents, but they live in input.js.
// We import them lazily to avoid circular deps.
let _buildInputBox, _bindInputEvents, _renderFileChips;
export function registerInputFns(build, bind, chips) { _buildInputBox = build; _bindInputEvents = bind; _renderFileChips = chips; }
function buildInputBox() { return _buildInputBox(); }
function bindInputEvents(id) { _bindInputEvents(id); }
function renderFileChips() { _renderFileChips(); }
