/**
 * apps/faq/public-app.js — the public FAQ chat surface (st_85ca4f3c).
 *
 * This is a faithful duplicate of apps/chat/public-app.js's initPublicChat(),
 * lifted out of the middleware-gated /chat/* tree so an anonymous visitor can
 * actually fetch the scripts. The chat tree is gated by the Edge middleware on
 * /chat and /chat/:path* (see middleware.js); /faq sits on its own URL prefix
 * that the middleware matcher does not include.
 *
 * Why duplicate (vs. import from /chat/*): even though some chat/* paths are
 * explicitly passed through in middleware.js (PASS_THROUGH_STATIC_ASSETS for
 * /chat/app.js, /chat/public-app.js, /chat/style.css, /chat/modules/*,
 * /chat/components/*), routing the public faq surface through paths the
 * middleware ALSO uses for the authed chat shell is a sharp edge — any future
 * middleware tightening on /chat would break this page. Owning the public
 * paths under /faq/* keeps the public surface independent of the authed
 * routing contract.
 *
 * Rendering is byte-faithful to the chat app — same marked + DOMPurify +
 * highlight stack, same message DOM (<div class="message {role}">), same
 * shell.css base bubble styles, same chat-style overrides. The only thing
 * stripped is anything that requires a session.
 *
 * What is intentionally NOT here:
 *   - initShell(): renders the authed global topbar + sidebar
 *   - every authenticated API call (whoami, belt, apps, models, prefs,
 *     labels, conversations, authed chat stream, prefetch, ttft-estimate,
 *     server-health, ambient chat events)
 *   - warm-cache reads, drop-folder + secure-input components
 *   - keyboard shortcut layer (it depends on the chat sidebar)
 *
 * What this surface fires:
 *   - On page load: no model call. The composer paints immediately.
 *   - POST /api/public-chat/stream — fires once per user-submitted turn.
 */
import { streamChatTurn } from './modules/stream-client.js';

const $ = (sel) => document.querySelector(sel);

// ── Markdown rendering — inlined from /static/shared/utils.js ──────────────
//
// utils.js cannot be loaded here because it is auth-coupled: it owns
// _redirectToLogin(), the offline-banner, fetchJSON()'s 401 redirect, and
// other behavior that only makes sense inside the authed shell. The pure
// renderer is small and stable, so we lift it verbatim. Same marked +
// DOMPurify pipeline → identical output to the chat app's renderProseMarkdown.

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderProseMarkdown(text, options = {}) {
  const raw = String(text || '');
  try {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      return escapeText(raw).replace(/\n/g, '<br>');
    }
    const parsed = marked.parse(raw, { mangle: false, headerIds: false });
    const clean = DOMPurify.sanitize(parsed, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style'],
    });
    const template = document.createElement('template');
    template.innerHTML = clean;
    template.content.querySelectorAll('a[href]').forEach((link) => {
      const href = link.getAttribute('href') || '';
      const isHash = href.startsWith('#');
      const isLocal = href.startsWith('/') || href.startsWith(location.origin);
      if (!isHash && !isLocal) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      }
    });
    template.content.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('rd-table-scroll')) return;
      const wrap = document.createElement('div');
      wrap.className = 'rd-table-scroll';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
    if (options.highlight !== false && typeof hljs !== 'undefined') {
      template.content.querySelectorAll('pre code').forEach((block) => {
        try { hljs.highlightElement(block); } catch {}
      });
    }
    return template.innerHTML;
  } catch (e) {
    console.error('[faq.renderProseMarkdown]', e.message);
    return escapeText(raw).replace(/\n/g, '<br>');
  }
}

// ── Message DOM — mirrors the chat app's addMessage exactly ────────────────
//
// Same class names (`.message {role}`, `.role`, `.content`) and same DOM
// shape as apps/chat/public-app.js → shell.css's base bubble styles apply
// without modification. The result on screen is indistinguishable from /chat.

function addMessage(role, content = '') {
  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;
  const label = document.createElement('div');
  label.className = 'role';
  label.textContent = role === 'user' ? 'You' : 'Miyagi';
  const body = document.createElement('div');
  body.className = 'content';
  body.innerHTML = renderProseMarkdown(content);
  wrap.appendChild(label);
  wrap.appendChild(body);
  $('#messagesInner').appendChild(wrap);
  $('#messages')?.scrollTo({ top: $('#messages').scrollHeight });
  return body;
}

// ── Composer — same DOM/classes as the chat app's input toolbar ────────────

function renderComposer(onSend) {
  const area = $('#inputArea');
  area.innerHTML = `
    <div class="input-container public-composer">
      <div class="input-main">
        <textarea class="chat-input" data-testid="multimodal-input" rows="1" placeholder="Ask anything about Robot Dojo"></textarea>
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

// ── Streaming a single public-chat turn ────────────────────────────────────
//
// Wraps streamChatTurn so the user-submit call site has the full flow in
// one place. (As of st_85ca4f3c the opening message is precomputed and no
// longer streams; this helper now serves user follow-ups only.) Returns
// the streamed answer text. The history array is mutated in place so
// follow-ups carry coherent context.

async function streamPublicTurn({ question, assistantNode, history, sessionRef, publicContext }) {
  let answer = '';
  await streamChatTurn({
    endpoint: '/api/public-chat/stream',
    body: { sessionId: sessionRef.id, context: publicContext, messages: history },
    rehydrateFromDB: null,
    onEvent(ev) {
      if (ev.type === 'status' && ev.sessionId) sessionRef.id = ev.sessionId;
      if (ev.type === 'status' && ev.status) {
        assistantNode.textContent = ev.status === 'streaming'
          ? 'Answering from public docs…'
          : 'Checking the public Robot Dojo docs…';
      }
      if (ev.type === 'delta') {
        answer += ev.text || '';
        assistantNode.innerHTML = renderProseMarkdown(answer);
      }
      if (ev.type === 'error') {
        assistantNode.innerHTML = renderProseMarkdown(
          `${ev.message || 'Public chat is unavailable.'}\n\nRetry in a moment.`,
        );
      }
    },
    onError(err) {
      assistantNode.innerHTML = renderProseMarkdown(
        `${err?.message || 'Public chat is unavailable.'}\n\nRetry in a moment.`,
      );
    },
    onDone() {
      if (answer.trim()) history.push({ role: 'assistant', content: answer });
    },
    stallMs: 30000,
  });
  return answer;
}

// ── Public init ────────────────────────────────────────────────────────────

export function initPublicChat() {
  // body.public-chat-mode flips shell.css + faq/style.css overrides on:
  // hides the global topbar, sidebar, and conv list, centers the chat
  // surface. Same flag the chat app sets in its setChromeForPublicMode().
  document.body.classList.add('public-chat-mode');
  $('#appBody')?.setAttribute('data-public-ask', 'true');

  const history = [];
  const sessionRef = { id: null };
  // The public context lookup matches what chat/public-app.js maps for the
  // default (no ?topic=) case — the FAQ corpus. Owner can deep-link
  // /faq?topic=install&prompt=… in the future with the same encoding the
  // chat app uses; we keep just the default for now to avoid carrying
  // half-implemented topic switching.
  const publicContext = 'faq-context';
  let sending = false;

  // Core turn: render the user message, then stream the assistant reply.
  const sendText = async (raw) => {
    if (sending) return;
    const text = (raw || '').trim();
    if (!text) return;
    history.push({ role: 'user', content: text });
    addMessage('user', text);
    const assistant = addMessage('assistant', 'Checking the public Robot Dojo docs…');
    sending = true;
    try {
      await streamPublicTurn({
        question: text,
        assistantNode: assistant,
        history,
        sessionRef,
        publicContext,
      });
    } finally {
      sending = false;
    }
  };

  const send = (input) => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    sendText(text);
  };

  renderComposer(send);

  document.body.classList.add('app-ready');
}
