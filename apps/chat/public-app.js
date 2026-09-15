import { streamChatTurn } from './modules/stream-client.js';

const $ = (sel) => document.querySelector(sel);

function renderMarkdown(text) {
  if (window.renderProseMarkdown) return window.renderProseMarkdown(text);
  if (window.marked && window.DOMPurify) {
    return window.DOMPurify.sanitize(window.marked.parse(text || ''), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style'],
    });
  }
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

function addMessage(role, content = '') {
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  const label = document.createElement('div');
  label.className = 'role';
  label.textContent = role === 'user' ? 'You' : 'Miyagi';
  const body = document.createElement('div');
  body.className = 'content';
  body.innerHTML = renderMarkdown(content);
  wrap.appendChild(label);
  wrap.appendChild(body);
  $('#messagesInner').appendChild(wrap);
  $('#messages')?.scrollTo({ top: $('#messages').scrollHeight });
  return body;
}

function setChromeForPublicMode() {
  const topic = getPublicTopic();
  document.title = 'Robot Dojo — Ask';
  if (typeof window.initShell === 'function') {
    window.initShell({
      searchPlaceholder: topic === 'install' || topic === 'setup' ? 'Install and setup guide' : 'Public product guide',
    });
  }
  $('#newItemLabel').textContent = 'New question';
  $('#topbarTitle').textContent = 'Ask Robot Dojo';
  $('#greeting').textContent = topic === 'install' || topic === 'setup' ? 'Ask about install and setup' : 'Ask the current Robot Dojo repo';
  $('#emptyPrompt').textContent = topic === 'install' || topic === 'setup'
    ? 'Install command, local setup, imports, model keys, and data boundaries.'
    : 'Product, install, privacy, tiers, architecture, and codebase guidance.';
  $('#convListView').style.display = 'none';
  $('#convDetailMenuWrapper').style.display = 'none';
  $('#backBtn').style.display = 'none';
  $('#topicList').innerHTML = `
    <div class="label-section">
      <div class="label-section-title">Public guide</div>
      <div class="label-item active">
        <span class="material-symbols-outlined icon-sm">forum</span>
        <span>${topic === 'install' || topic === 'setup' ? 'Install and setup' : 'Product guide'}</span>
      </div>
    </div>`;
}

function getPublicTopic() {
  return new URLSearchParams(location.search).get('topic') || '';
}

function getPublicContext() {
  const topic = getPublicTopic().toLowerCase();
  if (topic === 'install') return 'install-guide';
  if (topic === 'setup') return 'setup-guide';
  if (topic === 'privacy') return 'faq-privacy';
  if (topic === 'pricing' || topic === 'tiers') return 'faq-pricing';
  if (topic === 'repo' || topic === 'architecture') return 'repo-structure';
  return 'faq-context';
}

function renderComposer(onSend) {
  const area = $('#inputArea');
  area.innerHTML = `
    <div class="input-container public-composer">
      <div class="input-main">
        <textarea class="chat-input" data-testid="multimodal-input" rows="1" placeholder="Ask about Robot Dojo"></textarea>
        <button class="send-circle" data-testid="send-button" type="button" title="Send" disabled>
          <span class="material-symbols-outlined">arrow_upward</span>
        </button>
      </div>
      <div class="input-toolbar">
        <span class="tb-btn public-source-pill" aria-hidden="true">
          <span class="material-symbols-outlined icon-sm">verified</span>
          Public repo docs only
        </span>
        <span class="tb-spacer"></span>
      </div>
    </div>
  `;
  const input = area.querySelector('.chat-input');
  const send = area.querySelector('.send-circle');
  const refresh = () => {
    const hasText = !!input.value.trim();
    send.disabled = !hasText;
    send.classList.toggle('has-text', hasText);
  };
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!send.disabled) onSend(input);
    }
  });
  send.addEventListener('click', () => onSend(input));
}

export function initPublicChat() {
  setChromeForPublicMode();
  $('#mainArea').dataset.view = 'focus';
  $('#appBody')?.setAttribute('data-public-ask', 'true');
  $('#chatView').style.display = 'flex';
  $('#emptyState').style.display = 'none';
  const messages = [];
  let sessionId = null;
  let sending = false;
  const publicContext = getPublicContext();

  const send = async (input) => {
    if (sending) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    messages.push({ role: 'user', content: text });
    addMessage('user', text);
    const assistant = addMessage('assistant', 'Checking the public Robot Dojo docs…');
    let answer = '';
    sending = true;
    await streamChatTurn({
      endpoint: '/api/public-chat/stream',
      body: { sessionId, context: publicContext, messages },
      rehydrateFromDB: null,
      onEvent(ev) {
        if (ev.type === 'status' && ev.sessionId) sessionId = ev.sessionId;
        if (ev.type === 'status' && ev.status) {
          assistant.textContent = ev.status === 'streaming' ? 'Answering from public docs…' : 'Checking the public Robot Dojo docs…';
        }
        if (ev.type === 'delta') {
          answer += ev.text || '';
          assistant.innerHTML = renderMarkdown(answer);
        }
        if (ev.type === 'error') {
          assistant.innerHTML = renderMarkdown(`${ev.message || 'Public chat is unavailable.'}\n\nRetry in a moment, or use the installer help at /ask?topic=install.`);
        }
      },
      onError(err) {
        assistant.innerHTML = renderMarkdown(`${err?.message || 'Public chat is unavailable.'}\n\nRetry in a moment, or use the installer help at /ask?topic=install.`);
      },
      onDone() {
        if (answer.trim()) messages.push({ role: 'assistant', content: answer });
      },
      stallMs: 30000,
    });
    sending = false;
  };

  renderComposer(send);
  const opener = publicContext === 'install-guide' || publicContext === 'setup-guide'
    ? 'Ask me about installing Robot Dojo, setup, model keys, imports, or local data boundaries. I can only use the public repo projection, not private local data.'
    : 'Ask me about Robot Dojo product, install, privacy, tiers, architecture, or where things live in the current repo. I can only use the public repo projection, not private local data.';
  addMessage('assistant', opener);
  if (window.RobotDojoComponents?.setAppReady) window.RobotDojoComponents.setAppReady();
  else document.body.classList.add('app-ready');
  document.body.classList.add('public-chat-mode');
}
