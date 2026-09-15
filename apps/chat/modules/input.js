// Input — build input box, model dropdown, file handling, input events
import {
  models, selectedModel, selectedLabel, labels, conversationMode,
  savedSessionModel, attachedFiles, thinkingLevel, messages, agentName, sending,
  chatMode,
  setSelectedModel, setSavedSessionModel, setThinkingLevel,
  setAttachedFiles, setSelectedLabel, setUrlContext, setChatMode,
} from './state.js';
import { doSend, registerInputFns, openTopicLive, newConversation } from './chat.js?v=2026-09-13-4';
import { bindInlineRecognition } from './inline-recognition.js?v=2026-09-09-1';
import { buildTopicNavModel } from './topic-nav.js';

export const ASK_PLACEHOLDER = 'Ask Miyagi';
export const RESUME_PLACEHOLDER = 'Pick up where you left off, or ask for a recap';
export const PROFILE_IMPORT_PLACEHOLDER = 'Paste the full answer from the other AI';

export function composerPlaceholder() {
  if (typeof window !== 'undefined' && window.robotdojoProfileImportMode && (!messages || messages.length === 0)) {
    return PROFILE_IMPORT_PLACEHOLDER;
  }
  if (typeof window !== 'undefined' && window._lockedTopicSlug && (!messages || messages.length === 0)) {
    return RESUME_PLACEHOLDER;
  }
  return ASK_PLACEHOLDER;
}

function getTopicDisplayName() {
  if (!selectedLabel || selectedLabel === 'all' || selectedLabel === 'starred') return 'No Topic';
  if (typeof selectedLabel === 'object' && selectedLabel.names) {
    const tg = window._topicGroups?.find(g => g.slug === selectedLabel.group);
    return tg?.name || 'Group';
  }
  return selectedLabel;
}

function isNoTopicSelection() {
  return !selectedLabel || selectedLabel === 'all' || selectedLabel === 'starred';
}

function buildTopicDropdown() {
  const tree = buildTopicNavModel(labels, window._topicGroups || [], { editMode: false });
  const noneOn = isNoTopicSelection();
  let h = `<div class="pill-option${noneOn ? ' selected' : ''}" data-no-topic="1"><span class="check">${noneOn ? '&#10003;' : ''}</span><span>No Topic</span></div><div class="pill-divider"></div>`;
  let firstSection = true;
  const option = (l) => {
    const s = selectedLabel === l.name;
    return `<div class="pill-option${s ? ' selected' : ''}" data-topic="${esc(l.name)}"><span class="check">${s ? '&#10003;' : ''}</span><span>${esc(l.name)}</span></div>`;
  };
  tree.sections.forEach(({ group, children }) => {
    if (!firstSection) h += '<div class="pill-divider"></div>';
    firstSection = false;
    h += `<div class="pill-header">${esc(group.name)}</div>`;
    children.forEach((l) => { h += option(l); });
  });
  if (tree.orphans.length) {
    if (!firstSection) h += '<div class="pill-divider"></div>';
    firstSection = false;
    tree.orphans.forEach((l) => { h += option(l); });
  }
  // Empty-state guard: removing All/Starred means a user with zero visible
  // topics would see a blank dropdown. Show a placeholder pointing back to
  // the nav, which is where topic management lives.
  if (firstSection) {
    h = '<div class="pill-empty">No topics — manage topics in the left nav</div>';
  }
  return h;
}

function chatModeLabel() {
  return chatMode === 'deep' ? 'Deep' : 'Fast';
}

function buildModeDropdown() {
  const option = (mode, name) => {
    const s = chatMode === mode;
    return `<div class="pill-option${s ? ' selected' : ''}" data-chat-mode="${mode}" data-testid="chat-mode-${mode}"><span class="check">${s ? '&#10003;' : ''}</span><span>${name}</span></div>`;
  };
  return option('fast', 'Fast') + option('deep', 'Deep');
}

function paintChatMode() {
  const label = chatModeLabel();
  $$('[data-chat-mode-pill]').forEach((pill) => { pill.textContent = label; });
  $$('[data-testid="chat-mode-fast"], [data-testid="chat-mode-deep"]').forEach((o) => {
    const on = o.dataset.chatMode === chatMode;
    o.classList.toggle('selected', on);
    const check = o.querySelector('.check');
    if (check) check.innerHTML = on ? '&#10003;' : '';
  });
}

export function buildInputBox() {
  const mn = esc(models.find(m => m.key === selectedModel)?.name || selectedModel);
  const topicName = getTopicDisplayName();
  // data-testid hooks (st_74f45a1a) — the Playwright critical-path suite
  // depends on stable selectors that do NOT shift with theme/redesign work.
  const modePill = `<div class="pill-wrapper"><div class="chat-pill" data-chat-mode-pill title="Fast or Deep">${esc(chatModeLabel())}</div><div class="pill-dropdown" id="modeDropdown">${buildModeDropdown()}</div></div>`;
  return `<div class="input-container"><div class="input-main"><div class="entity-highlight-wrap"><div class="passive-entity-highlighter" aria-hidden="true"></div><textarea class="chat-input" data-testid="multimodal-input" placeholder="${esc(composerPlaceholder())}" rows="1"></textarea></div><button class="send-circle" data-testid="send-button" disabled>${I.send}</button></div><div class="file-chips" id="fileChips"></div><div class="input-toolbar"><label class="tb-icon-btn" title="Attach (f)"><span class="material-symbols-outlined icon-md">attach_file</span><input type="file" multiple hidden accept=".pdf,.docx,.doc,.xlsx,.xls,.txt,.md,.csv,.json,.xml,.html,.yaml,.yml,.js,.ts,.py,.sql,.sh,.jpg,.jpeg,.png,.gif,.webp"></label><span class="tb-spacer"></span>${modePill}<div class="pill-wrapper"><div class="chat-pill" title="Topic (t)">${esc(topicName)}</div><div class="pill-dropdown" id="topicDropdown">${buildTopicDropdown()}</div></div><div class="pill-wrapper"><div class="chat-pill" title="Model (m)">${mn}</div><div class="pill-dropdown" id="modelDropdown">${buildModelDropdown()}</div></div></div></div>`;
}

export function buildModelDropdown() {
  // WHY use all models (not just MODEL_KEYS): the API now returns only models whose
  // provider has a configured key. MODEL_KEYS is a legacy allowlist for the original
  // 4-model set — new providers (OpenAI, xAI) don't appear there.
  // Show all models the server returned; fall back to MODEL_KEYS filter only if the
  // server returned nothing (empty array = no providers configured).
  let chatModels = models.length > 0 ? [...models] : [];

  // Legacy compat: if all returned models happen to be in MODEL_KEYS, just use them.
  // If some are NOT in MODEL_KEYS (e.g. gpt-4o), include them too — the server
  // already filtered to configured providers.
  chatModels.sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99));

  if (chatModels.length === 0) {
    // No providers configured — guide the user to add a key
    return '<div class="pill-header" style="padding:8px 12px;color:var(--muted)">No providers configured</div>' +
      '<div class="pill-option" style="font-size:12px;padding:6px 12px"><a href="/account/integrations" style="color:var(--accent)">Add a provider key →</a></div>';
  }

  let h = '';
  let lastTier = -1;
  chatModels.forEach(m => {
    if (m.tierLabel && m.tier !== lastTier) {
      if (lastTier >= 0) h += '<div class="pill-divider"></div>';
      const speedIcon = m.speedIcon
        ? `<span class="material-symbols-outlined model-speed-icon">${esc(m.speedIcon)}</span>`
        : '';
      const speedLabel = m.speedLabel
        ? `<span class="model-speed-label">${esc(m.speedLabel)}</span>`
        : '';
      const slaLabel = m.slaLabel
        ? `<span class="model-speed-label">${esc(m.slaLabel)}</span>`
        : '';
      h += `<div class="pill-header model-lane-header"><span>${esc(m.tierLabel)}</span><span class="model-speed-badge">${speedIcon}${speedLabel}${slaLabel ? '<span class="model-speed-separator">·</span>' + slaLabel : ''}</span></div>`;
      lastTier = m.tier;
    }
    const s = m.key === selectedModel;
    const providerTag = m.provider ? `<span class="model-provider">${esc(m.provider)}</span>` : '';
    h += `<div class="pill-option model-option${s ? ' selected' : ''}" data-key="${m.key}"><span class="check">${s ? '&#10003;' : ''}</span><span class="model-info"><span class="model-name">${esc(m.name)}${m.isDefault ? ' <span class="model-default">default</span>' : ''}</span>${providerTag}</span></div>`;
  });
  return h;
}

export function bindInputEvents(id) {
  const c = document.getElementById(id), ta = $('.chat-input', c), sb = $('.send-circle', c), fi = $('input[type=file]', c);
  if (!c || !ta || !sb) return;
  const DEFAULT_PLACEHOLDER = 'Ask Miyagi';
  ta.addEventListener('input', () => {
    ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
    const has = !!ta.value.trim(); sb.disabled = sending || !has; sb.classList.toggle('has-text', has && !sending);
    // Action hint: only for the explicit assistant command namespace.
    // Entity/topic selection shortcuts are deprecated; other text is ordinary text.
    if (messages.length === 0) {
      if (ta.value.trimStart().toLowerCase().startsWith('@' + agentName.toLowerCase())) {
        ta.placeholder = `What should @${agentName} do?`;
      } else {
        ta.placeholder = DEFAULT_PLACEHOLDER;
      }
    }
  });
  const refreshInlineRecognition = () => setTimeout(() => ta.dispatchEvent(new Event('input')), 0);
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(ta, sb); refreshInlineRecognition(); } });
  window.addEventListener('robotdojo:chat-streaming', () => { sb.disabled = true; sb.classList.remove('has-text'); });
  window.addEventListener('robotdojo:chat-idle', () => {
    const has = !!ta.value.trim();
    sb.disabled = !has;
    sb.classList.toggle('has-text', has);
  });
  ta.addEventListener('paste', async (e) => {
    const text = e.clipboardData.getData('text/plain').trim();
    if (!text.match(/^https?:\/\//)) return; // not a URL — let normal paste happen
    e.preventDefault();
    showToast('Fetching URL context\u2026');
    try {
      const res = await fetchJSON('/api/fetch-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: text }) });
      if (res && res.ok !== false && res.text) {
        let domain = text;
        try { domain = new URL(text).hostname; } catch {}
        const contextStr = `URL: ${text}\n\n${res.title ? res.title + '\n\n' : ''}${res.text}`;
        setUrlContext(contextStr);
        showToast(`Context loaded from ${domain}`);
      } else {
        if (res?.error) showToast('Could not load URL: ' + res.error);
        else showToast('URL context unavailable \u2014 pasted as text');
      }
    } catch (err) {
      showToast('Could not load URL: ' + err.message);
    }
    // Insert the URL text into input regardless
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos), after = ta.value.slice(pos);
    ta.value = before + text + after;
    ta.dispatchEvent(new Event('input'));
  });
  sb.addEventListener('click', () => { doSend(ta, sb); refreshInlineRecognition(); });
  if (fi) fi.addEventListener('change', () => { handleFiles(fi.files); fi.value = ''; });

  const wrappers = $$('.pill-wrapper', c);
  wrappers.forEach(w => {
    const pill = $('.chat-pill', w), dd = $('.pill-dropdown', w);
    if (!pill || !dd) return;
    pill.addEventListener('click', e => {
      e.stopPropagation();
      $$('.pill-dropdown', c).forEach(d => { if (d !== dd) d.classList.remove('open'); });
      dd.classList.toggle('open');
    });
  });

  const tdd = $('#topicDropdown', c);
  if (tdd) {
    function bindTopicOpts() {
      // st_6360589a: option list is visible nav topics only — no 'all'/'starred'
      // sentinel. Each option's data-topic is a real topic name (matches l.name).
      $$('.pill-option', tdd).forEach(o => o.addEventListener('click', () => {
        if (o.dataset.noTopic) {
          newConversation();
          tdd.classList.remove('open');
          return;
        }
        const name = o.dataset.topic;
        const row = labels.find((l) => l.name === name);
        const slug = row?.slug || row?.context || name;
        openTopicLive(slug, { labelName: name });
        tdd.classList.remove('open');
      }));
    }
    bindTopicOpts();
  }

  const modeDd = $('#modeDropdown', c);
  if (modeDd) {
    function bindModeOpts() {
      $$('.pill-option', modeDd).forEach((o) => o.addEventListener('click', () => {
        setChatMode(o.dataset.chatMode);
        paintChatMode();
        modeDd.classList.remove('open');
        modeDd.innerHTML = buildModeDropdown();
        bindModeOpts();
      }));
    }
    bindModeOpts();
  }

  const mdd = $('#modelDropdown', c);
  if (mdd) {
    function bindModelOpts() {
      $$('.pill-option', mdd).forEach(o => o.addEventListener('click', () => {
        const key = o.dataset.key;
        setSelectedModel(key);
        if (conversationMode === 'session') setSavedSessionModel(selectedModel);
        const mpill = mdd.previousElementSibling;
        mpill.innerHTML = esc(models.find(m => m.key === selectedModel)?.name || selectedModel);
        mdd.classList.remove('open'); mdd.innerHTML = buildModelDropdown(); bindModelOpts();
      }));
    }
    bindModelOpts();
  }

  document.addEventListener('shell-file-drop', e => { if (e.detail?.files) handleFiles(e.detail.files); });
  bindInlineRecognition(ta);
  setTimeout(() => ta.focus(), 50);
}

export function closeDropdown() { $$('.pill-dropdown').forEach(d => d.classList.remove('open')); }

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.xml', '.html', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.log', '.sql', '.sh', '.py', '.js', '.ts', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.jsx', '.tsx', '.css', '.svg']);

export async function handleFiles(fl) {
  const SUPPORTED_BINARY = ['.pdf', '.docx', '.doc', '.xlsx', '.xls'];
  const uploads = Array.from(fl).map(f => {
    const lname = f.name.toLowerCase();
    const ext = lname.replace(/^.*(\.[^.]+)$/, '$1');
    const isBinary = SUPPORTED_BINARY.some(e => lname.endsWith(e));
    const isImage = IMAGE_EXTS.has(ext);
    if (f.size > MAX_FILE_SIZE) { showToast(`${f.name} -- too large (max 25MB)`); return Promise.resolve(); }
    if (!isBinary && !isImage && !TEXT_EXTS.has(ext)) { showToast(`${f.name} -- ${ext} not supported`); return Promise.resolve(); }
    if (isBinary || isImage) {
      const placeholder = { name: f.name, uploading: true };
      attachedFiles.push(placeholder); renderFileChips();
      const form = new FormData(); form.append('file', f);
      return fetchJSON('/api/upload', { method: 'POST', body: form })
        .then(d => { const idx = attachedFiles.indexOf(placeholder); if (idx === -1) return; if (!d) { attachedFiles.splice(idx, 1); return; /* fetchJSON already surfaced the server message */ } if (d.error) { attachedFiles.splice(idx, 1); showToast('Failed: ' + (d.message || d.error)); return; } attachedFiles[idx] = { name: d.name, fileId: d.fileId, content: d.content, mimeType: d.mimeType, pages: d.pages }; })
        .catch(() => { const idx = attachedFiles.indexOf(placeholder); if (idx !== -1) attachedFiles.splice(idx, 1); showToast('Upload failed: ' + f.name); })
        .finally(() => renderFileChips());
    }
    return new Promise(resolve => { const r = new FileReader(); r.onload = () => { attachedFiles.push({ name: f.name, content: r.result }); showToast(f.name + ' attached'); resolve(); }; r.readAsText(f); });
  });
  await Promise.all(uploads); renderFileChips();
}

export function renderFileChips() {
  $$('#fileChips').forEach(el => {
    if (window.RobotDojoComponents?.fileChip) {
      el.innerHTML = attachedFiles.map((f, i) => {
        const rawUrl = f.mimeType?.startsWith?.('image/') && f.fileId ? `/api/files/${encodeURIComponent(f.fileId)}/raw` : '';
        return window.RobotDojoComponents.fileChip({ ...f, rawUrl }, i);
      }).join('');
      return;
    }
    el.innerHTML = attachedFiles.map((f, i) => {
      if (f.uploading) return `<span class="file-chip uploading"><span class="chip-spinner"></span>${esc(f.name)}</span>`;
      if (f.mimeType?.startsWith('image/') && f.fileId) return `<span class="file-chip"><img src="/api/files/${f.fileId}/raw" alt="">${esc(f.name)} <button data-action="removeFile" data-idx="${i}">&#10005;</button></span>`;
      return `<span class="file-chip">${esc(f.name)} <button data-action="removeFile" data-idx="${i}">&#10005;</button></span>`;
    }).join('');
  });
}

export function removeFile(i) { attachedFiles.splice(i, 1); renderFileChips(); }

export function cycleModel() {
  const chatModels = [...models].sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99));
  if (!chatModels.length) {
    showToast('No providers configured');
    return;
  }
  const currentIndex = chatModels.findIndex((model) => model.key === selectedModel);
  const nextModel = chatModels[(currentIndex + 1) % chatModels.length] || chatModels[0];
  setSelectedModel(nextModel.key);
  if (conversationMode === 'session') setSavedSessionModel(nextModel.key);
  setThinkingLevel((nextModel.tier ?? 0) === 0 ? 'high' : 'medium');
  showToast(nextModel.name || nextModel.key);
  const label = esc(models.find(m => m.key === selectedModel)?.name || selectedModel);
  $$('.chat-pill[title="Model (m)"]').forEach(p => p.innerHTML = label);
  $$('#modelDropdown').forEach(d => { d.innerHTML = buildModelDropdown(); });
}

// Register with chat.js to break circular dependency
registerInputFns(buildInputBox, bindInputEvents, renderFileChips);
