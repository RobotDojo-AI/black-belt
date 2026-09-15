// Shared LLM streaming client and sidebar helpers — used by tasks, wiki, and future apps

async function streamLlmResponse(msgDiv, container, body, signal) {
  let fullContent = '';
  const res = await fetch('/api/chat/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', renderDirty = false;
  function scheduleRender() {
    if (renderDirty) return; renderDirty = true;
    requestAnimationFrame(() => {
      renderDirty = false;
      if (fullContent) { msgDiv.innerHTML = renderMarkdown(fullContent); msgDiv.classList.add('streaming-cursor'); }
      if (isNearBottom(container)) scrollToBottom(container);
    });
  }
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const d = JSON.parse(line.slice(5).trim());
      if (d.type === 'delta') { fullContent += d.text; scheduleRender(); }
      else if (d.type === 'done') { msgDiv.innerHTML = renderMarkdown(fullContent); msgDiv.classList.remove('streaming-cursor'); }
      else if (d.type === 'error') {
        const friendly = (d.message && d.message.length < 200)
          ? d.message
          : 'The model had trouble responding. Please try again in a moment.';
        msgDiv.innerHTML = esc(friendly);
        msgDiv.classList.remove('streaming-cursor');
      }
    }
  }
  return fullContent;
}

/**
 * Render LLM messages into a container.
 * @param {string} containerId - selector for the messages container
 * @param {Array} messages - array of {role, content}
 * @param {string} emptyText - text shown when no messages
 */
function renderLlmMessages(containerId, messages, emptyText) {
  const container = $(containerId);
  if (!container) return;
  if (!messages.length) {
    container.innerHTML = `<div class="llm-empty">${esc(emptyText || 'Ask Miyagi')}</div>`;
    return;
  }
  container.innerHTML = messages.map(m => {
    const cls = m.role === 'user' ? 'user' : 'assistant';
    const content = m.role === 'user' ? esc(m.content) : renderMarkdown(m.content);
    return `<div class="llm-msg ${cls}">${content}</div>`;
  }).join('');
  scrollToBottom(container);
}

/**
 * Toggle an LLM sidebar's collapsed state.
 * @param {string} sidebarId - selector for the sidebar element
 */
function toggleLlmSidebar(sidebarId) {
  const sidebar = $(sidebarId);
  if (sidebar) sidebar.classList.toggle('collapsed');
}

/**
 * Clear search input and reset filter.
 * @param {function} filterFn - function to call with empty string to reset results
 */
function clearSearchInput(filterFn) {
  const input = $('#persistentSearchInput');
  if (input) { input.value = ''; input.focus(); }
  const clear = $('#persistentSearchClear');
  if (clear) clear.classList.remove('visible');
  if (filterFn) filterFn('');
}

/**
 * Initialize search filter with debounce.
 * @param {function} filterFn - function to call with search query
 * @param {function} clearFn - function to call on clear/escape
 */
function initSearchFilter(filterFn, clearFn) {
  const input = $('#persistentSearchInput');
  if (!input) return;
  let timeout;
  input.addEventListener('input', () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => filterFn(input.value), 150);
    const clear = $('#persistentSearchClear');
    if (clear) clear.classList.toggle('visible', !!input.value);
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { clearFn(); input.blur(); }
  });
}
