// Chat app — mutable state (the ONLY module with mutable let exports)

export let currentConvId = null;
export let messages = [];
export let models = [];
export let labels = [];
export let sending = false;
export let attachedFiles = [];
export let abortController = null;
export let selectedModel = DEFAULT_MODEL;
export let searchTimeout = null;
export let selectedLabel = null;
export let inboxCount = 0;
export let thinkingLevel = 'medium';
export let modalCallback = null;
export let conversationMode = 'session';
export let chatMode = loadChatMode();
export let savedSessionModel = DEFAULT_MODEL;
export let conversationCostCents = 0;
export let cachedConvs = [];
export let collapsedGroups = {};
export let highlightedConvIdx = -1;
export let focusArea = 'threads';
export let highlightedLabelIdx = -1;
export let touchStartX = 0;
export let urlContext = null;
export const selectedConversations = new Set();
export let cachedActionConvs = [];
export let agentName = 'miyagi';
export let pendingActionChat = false;

// Setters
export function setCurrentConvId(id) { currentConvId = id; }
export function setMessages(msgs) { messages = msgs; }
export function setModels(m) { models = m; }
export function setLabels(l) { labels = l; }
export function setSending(v) {
  sending = v;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(sending ? 'robotdojo:chat-streaming' : 'robotdojo:chat-idle'));
  }
}
export function setAttachedFiles(f) { attachedFiles = f; }
export function setAbortController(c) { abortController = c; }
export function setSelectedModel(m) { selectedModel = m; }
export function setSearchTimeout(t) { searchTimeout = t; }
export function setSelectedLabel(l) { selectedLabel = l; }
export function setInboxCount(c) { inboxCount = c; }
export function setThinkingLevel(l) { thinkingLevel = l; }
export function setModalCallback(cb) { modalCallback = cb; }
export function setConversationMode(m) { conversationMode = m; }
export function setChatMode(m) {
  chatMode = m === 'deep' ? 'deep' : 'fast';
  try { localStorage.setItem('rd_chat_mode', chatMode); } catch { /* */ }
}

function loadChatMode() {
  try {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('rd_chat_mode') : null;
    if (stored === 'deep' || stored === 'fast') return stored;
  } catch { /* */ }
  return 'fast';
}
export function setSavedSessionModel(m) { savedSessionModel = m; }
export function setConversationCostCents(c) { conversationCostCents = c; }
export function addConversationCost(c) { conversationCostCents += c; }
export function setCachedConvs(c) { cachedConvs = c; }
export function setCollapsedGroups(g) { collapsedGroups = g; }
export function setHighlightedConvIdx(i) { highlightedConvIdx = i; }
export function setFocusArea(a) { focusArea = a; }
export function setHighlightedLabelIdx(i) { highlightedLabelIdx = i; }
export function setTouchStartX(x) { touchStartX = x; }
export function setUrlContext(c) { urlContext = c; }
export function setCachedActionConvs(c) { cachedActionConvs = c; }
export function setAgentName(n) { agentName = n; }
export function setPendingActionChat(v) { pendingActionChat = v; }
