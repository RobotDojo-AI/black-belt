(function () {
  function esc(value) {
    if (window.esc) return window.esc(value);
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function icon(name, className = 'icon-sm') {
    return `<span class="material-symbols-outlined ${className}">${esc(name)}</span>`;
  }

  function statusPill(label, tone = 'neutral') {
    return `<span class="rd-status-pill rd-status-${esc(tone)}">${esc(label)}</span>`;
  }

  function actionLink(action = {}) {
    const label = esc(action.label || 'Open');
    const cls = ['rd-action-btn', action.primary ? 'rd-action-btn-primary' : '', action.className || ''].filter(Boolean).join(' ');
    if (action.href) return `<a class="${esc(cls)}" href="${esc(action.href)}">${label}</a>`;
    const attrs = action.onclick ? ` onclick="${esc(action.onclick)}"` : '';
    return `<button type="button" class="${esc(cls)}"${attrs}>${label}</button>`;
  }

  function appState({ state = 'empty', icon: iconName = 'inbox', title = 'Nothing here yet', message = '', actions = [], className = '' } = {}) {
    const cls = ['rd-app-state', `rd-app-state-${state}`, className].filter(Boolean).join(' ');
    const actionHtml = actions.length ? `<div class="rd-app-state-actions">${actions.map(actionLink).join('')}</div>` : '';
    return `<div class="${esc(cls)}">${icon(iconName, 'rd-app-state-icon')}<div class="rd-app-state-title">${esc(title)}</div>${message ? `<p class="rd-app-state-message">${esc(message)}</p>` : ''}${actionHtml}</div>`;
  }

  function loadingState(label = 'Loading...', options = {}) {
    return appState({ state: 'loading', icon: options.icon || 'progress_activity', title: label, className: options.className || '' });
  }

  function errorState(options = {}) {
    return appState({ state: 'error', icon: options.icon || 'sync_problem', title: options.title || 'Something went wrong', message: options.message || '', actions: options.actions || [], className: options.className || '' });
  }

  function emptyState({ icon: iconName = 'inbox', title = 'Nothing here yet', hint = '', className = '' } = {}) {
    return appState({ state: 'empty', icon: iconName, title, message: hint, className: ['accounts-empty', className].filter(Boolean).join(' ') });
  }

  function markdownHtml(text) {
    const raw = String(text || '');
    if (window.renderProseMarkdown) return window.renderProseMarkdown(raw);
    if (window.marked && window.DOMPurify) {
      return window.DOMPurify.sanitize(window.marked.parse(raw), {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed'],
        FORBID_ATTR: ['style'],
      });
    }
    return esc(raw).replace(/\n/g, '<br>');
  }

  function prose({ content = '', className = '', framed = false } = {}) {
    const cls = ['rd-prose', framed ? 'rd-prose-framed' : '', className].filter(Boolean).join(' ');
    return `<article class="${esc(cls)}">${markdownHtml(content)}</article>`;
  }

  function tabBar({ tabs = [], active = '', className = '', attr = 'data-tab' } = {}) {
    const cls = ['rd-tabs', className].filter(Boolean).join(' ');
    return `<div class="${esc(cls)}">${tabs.map(tab => {
      const key = tab.key || tab.id || tab.label;
      return `<button type="button" class="rd-tab${key === active ? ' active' : ''}" ${esc(attr)}="${esc(key)}">${tab.icon ? icon(tab.icon, 'icon-sm') : ''}<span>${esc(tab.label || key)}</span></button>`;
    }).join('')}</div>`;
  }

  function sidebarSection({ title = '', body = '', className = '' } = {}) {
    return `<section class="rd-sidebar-section ${esc(className)}">${title ? `<div class="rd-sidebar-section-title">${esc(title)}</div>` : ''}${body}</section>`;
  }

  function metricCard({ label = '', value = '', hint = '', icon: iconName = '' } = {}) {
    return `<div class="rd-metric-card">${iconName ? icon(iconName, 'rd-metric-icon') : ''}<div class="rd-metric-body"><div class="rd-metric-label">${esc(label)}</div><div class="rd-metric-value">${esc(value)}</div>${hint ? `<div class="rd-metric-hint">${esc(hint)}</div>` : ''}</div></div>`;
  }

  function dataTable({ columns = [], rows = [], className = '' } = {}) {
    const cls = ['rd-data-table', className].filter(Boolean).join(' ');
    const head = columns.map(col => `<th>${esc(col.label || col.key || '')}</th>`).join('');
    const body = rows.map(row => `<tr>${columns.map(col => `<td data-label="${esc(col.label || col.key || '')}">${col.render ? col.render(row) : esc(row[col.key])}</td>`).join('')}</tr>`).join('');
    return `<div class="rd-table-scroll"><table class="${esc(cls)}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function pagination({ page = 0, pages = 1, onPrev = '', onNext = '', className = '' } = {}) {
    if (pages <= 1) return '';
    return `<div class="rd-pagination ${esc(className)}">
      <button type="button" class="rd-page-btn" onclick="${esc(onPrev)}" ${page <= 0 ? 'disabled' : ''}>Prev</button>
      <span class="rd-page-label">${esc(page + 1)} of ${esc(pages)}</span>
      <button type="button" class="rd-page-btn" onclick="${esc(onNext)}" ${page >= pages - 1 ? 'disabled' : ''}>Next</button>
    </div>`;
  }

  function chartPanel({ title = '', meta = '', body = '', footer = '', className = '' } = {}) {
    return `<div class="rd-chart-panel ${esc(className)}"><div class="rd-chart-panel-header"><div class="rd-chart-panel-title">${esc(title)}</div>${meta ? `<div class="rd-chart-panel-meta">${esc(meta)}</div>` : ''}</div><div class="rd-chart-panel-body">${body}</div>${footer ? `<div class="rd-chart-panel-footer">${footer}</div>` : ''}</div>`;
  }

  function fileChip(file = {}, index = 0) {
    const name = esc(file.name || 'file');
    if (file.uploading) return `<span class="file-chip uploading rd-file-chip"><span class="chip-spinner"></span>${name}</span>`;
    const thumb = file.mimeType?.startsWith?.('image/') && file.rawUrl ? `<img src="${esc(file.rawUrl)}" alt="">` : '';
    return `<span class="file-chip rd-file-chip">${thumb}${name} <button data-action="removeFile" data-idx="${esc(index)}">&#10005;</button></span>`;
  }

  function toolTrace({ summary = '', steps = [], hidden = true } = {}) {
    const stepHtml = steps.map(step => `<div class="tool-step">${step}</div>`).join('');
    return `<div class="tool-trace rd-tool-trace"><div class="thinking-summary" data-action="toggleThinking">${esc(summary)} <span class="thinking-chevron">${hidden ? '▸' : '▾'}</span></div><div class="thinking-steps" ${hidden ? 'hidden' : ''}>${stepHtml}</div></div>`;
  }

  function setAppReady() {
    clearTimeout(window.RobotDojoBootFallback);
    document.body?.classList.add('app-ready');
  }

  window.RobotDojoComponents = {
    icon,
    statusPill,
    appState,
    loadingState,
    errorState,
    emptyState,
    markdownHtml,
    prose,
    tabBar,
    sidebarSection,
    metricCard,
    dataTable,
    pagination,
    chartPanel,
    fileChip,
    toolTrace,
    setAppReady,
    renderProseMarkdown: markdownHtml,
  };
})();
