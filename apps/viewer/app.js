// Viewer app — stable markdown document URLs with first-class reading surfaces.
// Loaded via <script> in apps/viewer/index.html (no module bundler).

(function () {
const viewerState = {
  route: null,
  data: null,
  body: '',
};
const TIMELINE_PREVIEW_COUNT = 8;

document.addEventListener('DOMContentLoaded', async () => {
  const content = document.getElementById('viewerContent');
  if (!content) return;

  const route = resolveViewerRoute(window.location.pathname);
  viewerState.route = route;

  if (!route) {
    renderViewerError(content, {
      code: 'RDJ_VIEWER_ROUTE_UNKNOWN',
      title: 'Unknown viewer URL.',
      message: 'This path does not match a markdown document route.',
      detail: window.location.pathname,
      action: 'Use an agent, topic, entity, workbench, user, or docs URL.',
    });
    markViewerReady();
    return;
  }

  await loadRoute(route);
});

function resolveViewerRoute(path) {
  const reserved = new Set([
    'agents', 'user', 'topics', 'entities', 'people', 'companies', 'places',
    'workbenches', 'workbench', 'chat', 'health', 'network', 'account', 'accounts',
    'podcast', 'docs', 'connect', 'login', 'ask', 'faq', 'privacy', 'terms',
    'licensing', 'install', 'static', 'apps', 'api', 'auth', 'viewer',
    'transcripts', 'subscription', 'pulse', 'setup', 'me', 'version',
  ]);
  const matchers = [
    [/^\/topics\/(.+)$/, (m) => docRoute(`topics/${m[1]}`)],
    [/^\/docs\/(.+)$/, (m) => docRoute(m[1])],
    [/^\/agents\/?(.+)?$/, (m) => docRoute(`agents${m[1] ? '/' + m[1] : ''}`)],
    [/^\/user\/?(.+)?$/, (m) => docRoute(`user/${m[1] || 'context'}`)],
    [/^\/(people|companies|places)\/(.+)$/, (m) => docRoute(`entities/${m[1]}/${m[2]}`)],
    [/^\/entities\/(.+)$/, (m) => docRoute(`entities/${m[1]}`)],
    [/^\/workbenches\/(.+)$/, (m) => docRoute(`workbenches/${m[1]}`)],
    [/^\/workbench\/(.+)$/, (m) => docRoute(`workbench/${m[1]}`)],
  ];

  for (const [re, make] of matchers) {
    const match = path.match(re);
    if (match) return make(match);
  }

  const parts = String(path || '').split('/').filter(Boolean);
  if (parts[0] && !reserved.has(parts[0])) {
    return docRoute(parts.join('/'));
  }

  const transcriptMatch = path.match(/^\/transcripts\/(.+)$/);
  if (transcriptMatch) {
    const seg = decodeURIComponent(transcriptMatch[1]);
    const parts = seg.split('-');
    const shortId = /^[0-9a-f]{8}$/.test(parts.at(-1)) ? parts.at(-1) : null;
    if (shortId) return { apiPath: '/api/content/transcripts/' + shortId };
  }

  return null;
}

function docRoute(rest) {
  return {
    apiPath: '/api/content/docs/' + encodePath(rest),
  };
}

function encodePath(path) {
  return String(path || '')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try { return encodeURIComponent(decodeURIComponent(part)); }
      catch { return encodeURIComponent(part); }
    })
    .join('/');
}

async function loadRoute(route) {
  const content = document.getElementById('viewerContent');
  content.innerHTML = loadingHtml();
  markViewerReady();

  try {
    const preload = window.RobotDojoViewerPreload;
    if (preload?.apiPath === route.apiPath && preload.data && typeof preload.data === 'object') {
      renderPayload(preload.data);
      markViewerReady();
      return;
    }

    const res = await fetch(route.apiPath, { credentials: 'same-origin' });
    const responsePath = safePathname(res.url);
    if (responsePath === '/connect' || responsePath === '/login') {
      renderViewerError(content, {
        code: 'RDJ_VIEWER_AUTH_REDIRECT',
        title: 'Viewer needs a fresh login.',
        message: 'The document request was redirected to Connect instead of returning markdown JSON.',
        detail: `${route.apiPath} -> ${responsePath}`,
        action: 'Paste your dojo token on Connect, then reopen this URL.',
      });
      markViewerReady();
      return;
    }
    if (res.status === 401) {
      renderViewerError(content, {
        code: 'RDJ_VIEWER_AUTH_REQUIRED',
        title: 'Viewer is not signed in.',
        message: 'The document API rejected this browser session.',
        detail: route.apiPath,
        action: 'Open Connect and paste your dojo token.',
      });
      markViewerReady();
      return;
    }
    if (!res.ok) {
      const apiError = await readErrorBody(res);
      renderViewerError(content, {
        code: codeForStatus(res.status, apiError?.error),
        title: titleForStatus(res.status),
        message: apiError?.error ? `API error: ${apiError.error}` : `The document API returned HTTP ${res.status}.`,
        detail: route.apiPath,
        action: actionForStatus(res.status),
      });
      markViewerReady();
      return;
    }
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      renderViewerError(content, {
        code: 'RDJ_VIEWER_API_NON_JSON',
        title: 'Viewer got the wrong response type.',
        message: 'The document API returned something other than JSON.',
        detail: `${route.apiPath} (${contentType || 'no content-type'})`,
        action: 'Reconnect, then refresh. If it repeats, send this code.',
      });
      markViewerReady();
      return;
    }
    let data;
    try {
      data = await res.json();
    } catch (error) {
      renderViewerError(content, {
        code: 'RDJ_VIEWER_JSON_PARSE',
        title: 'Viewer could not read the document response.',
        message: error?.message || 'JSON parsing failed.',
        detail: route.apiPath,
        action: 'Refresh. If it repeats, send this code.',
      });
      markViewerReady();
      return;
    }
    if (!data || typeof data !== 'object' || (data.body != null && typeof data.body !== 'string')) {
      renderViewerError(content, {
        code: 'RDJ_VIEWER_BAD_PAYLOAD',
        title: 'Viewer got an incomplete document response.',
        message: 'The document API did not return the expected markdown payload.',
        detail: route.apiPath,
        action: 'Refresh. If it repeats, send this code.',
      });
      markViewerReady();
      return;
    }
    renderPayload(data);
  } catch (error) {
    renderViewerError(content, {
      code: error?.name === 'AbortError' ? 'RDJ_VIEWER_REQUEST_ABORTED' : 'RDJ_VIEWER_NETWORK_ERROR',
      title: 'Viewer could not reach the document API.',
      message: error?.message || 'The request failed before the document could load.',
      detail: route.apiPath,
      action: 'Check that Robot Dojo is running, reconnect, then refresh.',
    });
  }

  markViewerReady();
}

function renderPayload(data) {
  viewerState.data = data;
  viewerState.body = data.body || '';
  const title = documentTitle(data, viewerState.body);
  document.title = title + ' — Robot Dojo';
  renderViewer('read');
}

function safePathname(url) {
  try { return new URL(url, window.location.origin).pathname; }
  catch { return ''; }
}

async function readErrorBody(res) {
  try {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) return await res.clone().json();
  } catch {}
  return null;
}

function codeForStatus(status, apiError) {
  if (status === 401) return 'RDJ_VIEWER_AUTH_REQUIRED';
  if (status === 403) return 'RDJ_VIEWER_FORBIDDEN';
  if (status === 404) return 'RDJ_VIEWER_DOC_NOT_FOUND';
  if (status === 409) return 'RDJ_VIEWER_DOC_CONFLICT';
  if (status === 429) return 'RDJ_VIEWER_RATE_LIMITED';
  if (status === 502 || apiError === 'server_unreachable') return 'RDJ_VIEWER_RELAY_UNREACHABLE';
  if (status >= 500) return 'RDJ_VIEWER_API_ERROR';
  return `RDJ_VIEWER_HTTP_${status}`;
}

function titleForStatus(status) {
  if (status === 403) return 'Viewer is not allowed to open this document.';
  if (status === 404) return 'Viewer could not find that document.';
  if (status === 429) return 'Viewer is being rate limited.';
  if (status === 502) return 'Viewer could not reach your Robot Dojo.';
  if (status >= 500) return 'Viewer hit a server error.';
  return 'Viewer could not load the document.';
}

function actionForStatus(status) {
  if (status === 404) return 'Check the URL slug or open the document from search.';
  if (status === 502) return 'Make sure Robot Dojo is running on your Mac, then refresh.';
  if (status === 429) return 'Wait a minute, then refresh.';
  return 'Refresh. If it repeats, send this code.';
}

function renderViewerError(content, { code, title, message, detail, action }) {
  const safeCode = code || 'RDJ_VIEWER_UNKNOWN';
  content.innerHTML = `
    <section class="viewer-error" data-error-code="${viewerEsc(safeCode)}" role="alert">
      <div class="viewer-error-title">${viewerEsc(title || 'Viewer error.')}</div>
      <code class="viewer-error-code">${viewerEsc(safeCode)}</code>
      ${message ? `<div class="viewer-error-message">${viewerEsc(message)}</div>` : ''}
      ${detail ? `<div class="viewer-error-detail">${viewerEsc(detail)}</div>` : ''}
      ${action ? `<div class="viewer-error-action">${viewerEsc(action)}</div>` : ''}
    </section>
  `;
}

function renderViewer(mode) {
  const content = document.getElementById('viewerContent');
  const data = viewerState.data || {};
  const pageModel = buildViewerPageModel(data, viewerState.body);
  const title = pageModel.title;
  const history = Array.isArray(data.history) ? data.history : [];
  const metaItems = documentMetaItems(data, history, pageModel.frontmatter);
  document.title = title + ' — Robot Dojo';

  content.innerHTML = `
    <div class="viewer-shell" data-mode="${viewerEsc(mode)}">
      <header class="viewer-hero">
        <div class="viewer-title-group">
          <div class="viewer-kind-row">
            ${pageModel.kind ? `<span class="viewer-kind">${viewerEsc(pageModel.kind)}</span>` : ''}
          </div>
          <h1>${viewerEsc(title)}</h1>
          ${pageModel.thinMeta.length ? `<p>${viewerEsc(pageModel.thinMeta.join(' · '))}</p>` : ''}
        </div>
        <div class="viewer-actions" aria-label="Document actions">
          <span id="viewerStatus" class="viewer-status" aria-live="polite"></span>
          ${iconButton('link', 'Copy link', 'viewerCopyBtn')}
        </div>
      </header>

      <div class="viewer-layout">
        <aside class="viewer-left-nav">
          ${projectionNavHtml(pageModel.navItems)}
        </aside>
        <section class="viewer-document" aria-label="Markdown document">
          ${projectionHtml(pageModel, metaItems)}
        </section>
      </div>
    </div>
  `;

  document.getElementById('viewerCopyBtn')?.addEventListener('click', copyViewerLink);
}

function buildViewerPageModel(data, body) {
  const serverProjection = projectionModelFromPayload(data);
  if (serverProjection) return serverProjection;

  const parts = splitMarkdownDocument(body);
  const markdown = cleanProjectionMarkdown(parts.markdown);
  const sections = parseMarkdownSections(markdown);
  const kind = documentKind(data, parts.frontmatter);
  const title = displayTitleForKind(documentTitle(data, body), kind);
  let currentRead = selectCurrentReadMarkdown(kind, sections, markdown, parts.frontmatter, title);
  currentRead = ensureHumanCurrentRead(kind, title, currentRead, sections);
  let workingBrief = selectWorkingBriefMarkdown(kind, sections, markdown, currentRead, parts.frontmatter, title);
  workingBrief = ensureHumanWorkingBrief(kind, title, workingBrief, currentRead, sections);
  const timeline = mergeTimelineEvidence(
    extractTimelineItems(sections, markdown),
    timelineEvidenceItems(data),
  );
  const timelineCounts = timelineEvidenceCounts(data);
  const thinMeta = thinMetaItems(data, parts.frontmatter);
  const targetType = correctionTargetType(kind, data, parts.frontmatter);
  const targetId = correctionTargetId(data, parts.frontmatter);
  const url = data.url || window.location.pathname || '';
  const navItems = [
    ...(kind === 'workbench' || kind === 'topic' ? [['library', 'Research']] : []),
    ['current-read', '1k summary'],
    ['working-brief', '4k summary'],
    ['timeline', 'Timeline'],
    ['metadata', 'Metadata'],
  ];

  return {
    title,
    kind,
    targetType,
    targetId,
    url,
    frontmatter: parts.frontmatter,
    workbench: data.workbench || null,
    library: data.workbench?.library || data.library || null,
    corrections: Array.isArray(data.corrections) ? data.corrections : [],
    markdown,
    currentRead,
    workingBrief,
    timeline,
    timelineCounts,
    thinMeta,
    navItems,
  };
}

function projectionModelFromPayload(data = {}) {
  const projection = data?.projection;
  if (!projection || typeof projection !== 'object') return null;
  const navItems = Array.isArray(projection.navItems) && projection.navItems.length
    ? projection.navItems
    : [
      ['current-read', '1k summary'],
      ['working-brief', '4k summary'],
      ['timeline', 'Timeline'],
      ['metadata', 'Metadata'],
    ];
  return {
    title: String(projection.title || data.title || documentTitle(data, data.body || '') || 'Document').trim(),
    kind: String(projection.kind || data.kind || '').trim(),
    targetType: String(projection.targetType || correctionTargetType(projection.kind || data.kind, data, projection.frontmatter || {})).trim(),
    targetId: String(projection.targetId || correctionTargetId(data, projection.frontmatter || {})).trim(),
    url: String(projection.url || data.url || window.location.pathname || '').trim(),
    frontmatter: projection.frontmatter && typeof projection.frontmatter === 'object' ? projection.frontmatter : {},
    workbench: projection.workbench || data.workbench || null,
    library: projection.workbench?.library || data.workbench?.library || data.library || null,
    corrections: Array.isArray(projection.corrections) ? projection.corrections : (Array.isArray(data.corrections) ? data.corrections : []),
    markdown: '',
    currentRead: String(projection.currentRead || '').trim(),
    workingBrief: String(projection.workingBrief || '').trim(),
    timeline: Array.isArray(projection.timeline) ? projection.timeline.map(normalizeServerTimelineItem).filter((item) => item.dateText && item.title) : [],
    timelineCounts: projection.timelineCounts || {},
    thinMeta: Array.isArray(projection.thinMeta) ? projection.thinMeta.slice(0, 4) : thinMetaItems(data, projection.frontmatter || {}),
    navItems,
    projectionVersion: projection.version || '',
    sourceFingerprint: projection.sourceFingerprint || '',
  };
}

function normalizeServerTimelineItem(item = {}) {
  return {
    dateText: String(item.dateText || '').trim(),
    title: String(item.title || '').trim(),
    body: String(item.body || '').trim(),
    sourceLabel: String(item.sourceLabel || '').trim(),
    sourceRef: String(item.sourceRef || '').trim(),
    phase: String(item.phase || '').trim(),
  };
}

function correctionTargetType(kind, data = {}, frontmatter = {}) {
  const raw = frontmatter.entity_type || data.entityType || data.kind || kind || 'document';
  const normalized = String(raw || '').toLowerCase();
  if (normalized === 'people') return 'person';
  if (normalized === 'companies') return 'company';
  if (normalized === 'places') return 'place';
  if (normalized === 'entity') return data.entityType || frontmatter.entity_type || 'entity';
  return normalized || 'document';
}

function correctionTargetId(data = {}, frontmatter = {}) {
  return String(
    frontmatter.entity_id
    || data.entityId
    || data.id
    || data.topicSlug
    || data.workbenchId
    || data.relPath
    || data.url
    || window.location.pathname
    || '',
  ).trim();
}

function documentKind(data, frontmatter = {}) {
  if (frontmatter.entity_type) return frontmatter.entity_type;
  if (data.kind === 'entity' && data.entityType) return data.entityType;
  if (data.entityType) return data.entityType;
  if (data.kind) return data.kind;
  if (data.topicSlug) return 'topic';
  const route = viewerState.route?.apiPath || '';
  if (route.includes('/workbenches/') || route.includes('/workbench/')) return 'workbench';
  if (route.includes('/agents')) return 'agent';
  return 'document';
}

function thinMetaItems(data, frontmatter = {}) {
  const items = [];
  const type = frontmatter.entity_type || data.entityType || data.kind || '';
  const entity = data.evidence?.entity || {};
  const counts = data.evidence?.counts || {};
  if (type) items.push(type);
  if (counts.total || counts.timeline) items.push(`${counts.total || counts.timeline} events`);
  if (entity.firstSeen || entity.lastSeen) {
    const span = [entity.firstSeen, entity.lastSeen].filter(Boolean).join(' to ');
    if (span) items.push(span);
  }
  if (frontmatter.generated_at) items.push(`updated ${formatMetaDate(frontmatter.generated_at)}`);
  if (data.history?.length) items.push(`${data.history.length} versions`);
  return items.slice(0, 4);
}

function projectionHtml(model, metaItems = []) {
  return `
    <article id="viewerArticle" class="viewer-projection" aria-label="Document projection">
      ${model.kind === 'workbench' || model.kind === 'topic' ? `
      <section id="library" class="viewer-section viewer-library-section">
        ${sectionHeadingHtml(model, 'library', 'Research')}
        ${researchLibraryHtml(model.library || model.workbench)}
      </section>` : ''}
      <section id="current-read" class="viewer-section viewer-current-read">
        ${sectionHeadingHtml(model, 'current-read', '1k summary')}
        ${projectionMarkdownHtml(model.currentRead, 'No 1k summary yet.')}
      </section>

      <section id="working-brief" class="viewer-section">
        ${sectionHeadingHtml(model, 'working-brief', '4k summary')}
        ${projectionMarkdownHtml(model.workingBrief, 'No 4k summary yet.')}
      </section>

      <section id="timeline" class="viewer-section viewer-timeline-section">
        ${sectionHeadingHtml(model, 'timeline', 'Timeline')}
        ${timelineHtml(model.timeline, model)}
      </section>

      <section id="metadata" class="viewer-section viewer-metadata-section">
        ${sectionHeadingHtml(model, 'metadata', 'Metadata')}
        ${metadataHtml(metaItems, model)}
      </section>
    </article>
  `;
}

function sectionHeadingHtml(model, sectionId, label, extra = {}) {
  return `
    <div class="viewer-section-head">
      <div class="viewer-section-kicker">${viewerEsc(label)}</div>
      ${correctionLinkHtml(model, sectionId, label, extra)}
    </div>
  `;
}

function projectionMarkdownHtml(markdown, emptyText) {
  const text = String(markdown || '').trim();
  return text ? `<div class="viewer-prose">${markdownHtml(text)}</div>` : `<p class="viewer-muted">${viewerEsc(emptyText)}</p>`;
}

function projectionNavHtml(items) {
  return `
    <nav class="viewer-nav" aria-label="Document sections">
      ${items.map(([id, label]) => `<a href="#${viewerEsc(id)}">${viewerEsc(label)}</a>`).join('')}
    </nav>
  `;
}

function metadataHtml(items, model = {}) {
  const details = items.length ? `
    <div class="viewer-metadata-card" aria-label="Document metadata">
      <dl>
        ${items.map(([label, value]) => `
          <div>
            <dt>${viewerEsc(label)}</dt>
            <dd>${viewerEsc(value)}</dd>
          </div>
        `).join('')}
      </dl>
    </div>
  ` : '<p class="viewer-muted">No metadata has been recorded yet.</p>';
  return `
    ${workbenchSubstrateHtml(model.workbench)}
    ${correctionsHtml(model.corrections)}
    ${details}
  `;
}

function correctionsHtml(corrections) {
  const rows = Array.isArray(corrections) ? corrections.filter((item) => item?.summary || item?.correction_text) : [];
  if (!rows.length) return '';
  return `
    <div class="viewer-corrections">
      <h2>Corrections</h2>
      <ol>
        ${rows.slice(0, 12).map((item) => `
          <li>
            <p>${viewerEsc(item.summary || item.correction_text)}</p>
            <small>${viewerEsc([formatMetaDate(item.valid_at || item.recorded_at), item.section].filter(Boolean).join(' · '))}</small>
          </li>
        `).join('')}
      </ol>
    </div>
  `;
}

function researchLibraryHtml(workbench) {
  if (!workbench) return '<p class="viewer-muted">No topic files yet.</p>';
  const library = workbench.library || workbench;
  const reports = Array.isArray(library.reports) ? library.reports : [];
  const research = Array.isArray(library.research) ? library.research : [];
  const artifacts = Array.isArray(library.artifacts) ? library.artifacts : [];
  if (!reports.length && !research.length && !artifacts.length) {
    return `<p class="viewer-muted">No published research or artifacts yet. They appear here after a topic session close.</p>`;
  }
  const group = (title, items) => items.length ? `
    <h3>${viewerEsc(title)}</h3>
    <div class="viewer-substrate-grid">
      ${items.slice(0, 40).map((file) => `
        <a class="viewer-substrate-file" href="${viewerEsc(file.url || '#')}">
          <span>${viewerEsc(file.name)}</span>
          <small>${viewerEsc(file.kind || '')}</small>
        </a>
      `).join('')}
    </div>
  ` : '';
  return `
    <div class="viewer-research-library">
      ${workbench.publicUrl ? `<p class="viewer-substrate-root">Stable URL: <a href="${viewerEsc(workbench.publicUrl)}">${viewerEsc(workbench.publicUrl)}</a></p>` : ''}
      ${group('Reports', reports)}
      ${group('Research', research)}
      ${group('Artifacts', artifacts)}
    </div>
  `;
}

function workbenchSubstrateHtml(workbench) {
  if (!workbench) return '';
  const canonical = Array.isArray(workbench.canonical) ? workbench.canonical : [];
  const entries = Array.isArray(workbench.entries) ? workbench.entries : [];
  return `
    <div class="viewer-workbench-substrate">
      <h2>Topic files</h2>
      ${workbench.publicUrl ? `<p class="viewer-substrate-root"><a href="${viewerEsc(workbench.publicUrl)}">${viewerEsc(workbench.publicUrl)}</a></p>` : ''}
      ${workbench.root ? `<p class="viewer-substrate-root">${viewerEsc(workbench.root)}</p>` : ''}
      <div class="viewer-substrate-grid">
        ${canonical.map((file) => `
          <a class="viewer-substrate-file${file.exists ? '' : ' is-missing'}" href="${viewerEsc(file.url || '#')}">
            <span>${viewerEsc(file.name)}</span>
            <small>${file.exists ? `${formatFileSize(file.bytes)} · ${formatMetaDate(file.updatedAt)}` : 'missing'}</small>
          </a>
        `).join('')}
      </div>
      ${entries.length ? `
        <details class="viewer-substrate-extra">
          <summary>Substrate</summary>
          <ul>
            ${entries.map((entry) => `
              <li>
                ${entry.url ? `<a href="${viewerEsc(entry.url)}">${viewerEsc(entry.kind === 'directory' ? `${entry.name}/` : entry.name)}</a>` : `<span>${viewerEsc(entry.kind === 'directory' ? `${entry.name}/` : entry.name)}</span>`}
                <small>${viewerEsc(entry.kind)}${entry.kind === 'file' ? ` · ${formatFileSize(entry.bytes)}` : ''}</small>
              </li>
            `).join('')}
          </ul>
        </details>
      ` : ''}
    </div>
  `;
}

function correctionLinkHtml(model, sectionId, sectionLabel, extra = {}) {
  const href = correctionHref(model, sectionId, sectionLabel, extra);
  return `<a class="viewer-correct-link" href="${viewerEsc(href)}" title="Correct ${viewerEsc(sectionLabel)}" aria-label="Correct ${viewerEsc(sectionLabel)}">
    <span class="material-symbols-outlined">edit_note</span>
  </a>`;
}

function correctionHref(model, sectionId, sectionLabel, extra = {}) {
  const payload = correctionPayload(model, sectionId, sectionLabel, extra);
  const prefill = correctionPrefill(payload, sectionLabel);
  const params = new URLSearchParams();
  params.set('correction', encodeCorrectionPayload(payload));
  params.set('prefill', prefill);
  return `/chat?${params.toString()}`;
}

function correctionPayload(model, sectionId, sectionLabel, extra = {}) {
  return {
    mode: 'viewer_correction',
    target_type: model.targetType || model.kind || 'document',
    target_id: model.targetId || model.url || '',
    target_url: model.url || window.location.pathname || '',
    target_title: model.title || '',
    section: normalizeCorrectionSection(sectionId),
    section_label: sectionLabel || sectionId,
    claim_text: String(extra.claimText || '').trim(),
    source_ref: String(extra.sourceRef || '').trim(),
    viewer_version: 'viewer-rich-20260819-2',
  };
}

function normalizeCorrectionSection(sectionId) {
  if (sectionId === 'current-read') return '1k_summary';
  if (sectionId === 'working-brief') return '4k_summary';
  return sectionId || 'document';
}

function correctionPrefill(payload, sectionLabel) {
  return [
    `Correction for ${payload.target_title || payload.target_url}`,
    `Section: ${sectionLabel || payload.section}`,
    '',
    'Replace this line with the correction to record.',
  ].join('\n');
}

function encodeCorrectionPayload(payload) {
  const json = JSON.stringify(payload);
  if (typeof btoa === 'function') {
    try {
      return btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    } catch {
      // Fall through to URI encoding.
    }
  }
  return encodeURIComponent(json);
}

function parseMarkdownSections(markdown) {
  const sections = [];
  let current = { level: 0, title: 'Document', lines: [] };
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      sections.push({ ...current, content: current.lines.join('\n').trim() });
      current = {
        level: heading[1].length,
        title: heading[2].replace(/[#\s]+$/, '').trim(),
        lines: [],
      };
    } else {
      current.lines.push(line);
    }
  }
  sections.push({ ...current, content: current.lines.join('\n').trim() });
  return sections.filter((section) => section.title || section.content);
}

function findSection(sections, pattern) {
  const direct = sections.find((section) => pattern.test(section.title) && hasMeaningfulMarkdown(section.content));
  if (direct) return direct;
  const index = sections.findIndex((section) => pattern.test(section.title));
  if (index < 0) return null;
  return sections.slice(index + 1).find((section) =>
    hasMeaningfulMarkdown(section.content)
    && !isProjectionNoiseSection(section.title));
}

function selectCurrentReadMarkdown(kind, sections, markdown, frontmatter = {}, title = '') {
  const candidates = [];
  if (kind === 'person' || kind === 'people') {
    candidates.push(/read on/i, /summary/i, /connection/i, /reconnection call/i, /profile/i);
  } else if (kind === 'company' || kind === 'companies') {
    candidates.push(/fit for role/i, /summary/i, /what (?:they|the company) do(?:es)?/i, /technical bet/i);
  } else if (kind === 'place' || kind === 'places') {
    candidates.push(/summary/i, /history/i);
  } else if (kind === 'workbench') {
    candidates.push(/current thesis/i, /latest state/i, /summary/i, /latest thinking/i, /current question/i, /next action/i);
  } else if (kind === 'topic') {
    candidates.push(/current read/i, /what this topic covers/i, /what this topic is/i, /latest state/i, /summary/i, /history/i);
  } else if (kind === 'agent') {
    candidates.push(/identity/i, /capabilities/i, /mentor/i, /north star/i, /role/i);
  } else {
    candidates.push(/current read/i, /summary/i, /latest state/i);
  }

  for (const pattern of candidates) {
    const section = findSection(sections, pattern);
    if (section) {
      return trimMarkdown(displayProjectionMarkdown(projectCurrentRead(kind, section.content, frontmatter, sections, title)), 1100);
    }
  }

  const firstMeaningful = sections.find((section) =>
    section.level > 0
    && hasMeaningfulMarkdown(section.content)
    && !isProjectionNoiseSection(section.title));
  const fallback = firstMeaningful?.content || stripLeadingTitle(markdown);
  return trimMarkdown(displayProjectionMarkdown(projectCurrentRead(kind, fallback, frontmatter, sections, title)), 1100);
}

function ensureHumanCurrentRead(kind, title, currentRead, sections) {
  const normalized = normalizeMarkdownBody(currentRead);
  if (normalized.length >= 80 && !isUnhumanCurrentRead(normalized, kind)) {
    if (/^(topic|workbench)$/i.test(String(kind || '')) && shouldPreferKnownFallback(title, sections, normalized)) {
      return fallbackCurrentRead(kind, title, sections);
    }
    const entityFallback = fallbackEntityCurrentRead(kind, title, sections, normalized);
    if (entityFallback) return entityFallback;
    return currentRead;
  }

  const assembled = assembleCurrentReadFromSections(kind, sections);
  if (normalizeMarkdownBody(assembled).length >= 80 && !isUnhumanCurrentRead(assembled, kind)) return trimMarkdown(assembled, 1100);

  if (kind === 'workbench' || kind === 'topic') return fallbackCurrentRead(kind, title, sections);
  return currentRead;
}

// Owner-specific per-topic prose lives ONLY in the gitignored
// config/viewer-topic-lens.user.json override, injected by the server as
// window.RobotDojoTopicLens (see lib/viewer-topic-lens.js). The tracked viewer
// ships GENERIC fallbacks and consults this lens first: on this box the owner's
// rich institutional prose renders; on a fresh clone the lens is empty and the
// generic default renders. `match` is a case-insensitive regex tested against
// the normalized topic key; `field` is currentRead | deepBrief | entityRead.
function topicLensEntries() {
  const injected = (typeof window !== 'undefined' && window && window.RobotDojoTopicLens)
    || (typeof globalThis !== 'undefined' && globalThis && globalThis.RobotDojoTopicLens)
    || null;
  return injected && Array.isArray(injected.lenses) ? injected.lenses : [];
}

function topicLensOverride(key, field) {
  const target = String(key || '');
  for (const entry of topicLensEntries()) {
    if (!entry || typeof entry.match !== 'string') continue;
    let re;
    try {
      re = new RegExp(entry.match, 'i');
    } catch {
      continue; // a malformed override pattern is never fatal
    }
    if (re.test(target) && typeof entry[field] === 'string' && entry[field]) return entry[field];
  }
  return '';
}

function fallbackEntityCurrentRead(kind, title, sections = [], currentRead = '') {
  if (!/^(company|companies)$/i.test(String(kind || ''))) return '';
  const key = normalizedTopicKey(title, sections);
  if (!/company radar|linked (?:person|people)|human story|company map|company or institution trace|not yet a felt company page|contact density|human doorway|structured data only/i.test(String(currentRead || ''))) return '';
  return topicLensOverride(key, 'entityRead');
}

function isUnhumanCurrentRead(value, kind = '') {
  const text = String(value || '').trim();
  if (!text) return true;
  return isThinWorkbenchRegistration(text)
    || isPointerOrProcessSummary(text)
    || (/^(topic|workbench)$/i.test(String(kind || '')) && isPathForwardSummary(text));
}

function isThinWorkbenchRegistration(value) {
  const text = String(value || '').trim();
  return /registered as .*topic workbench/i.test(text)
    || /^[_*]*T[12]\s+meta-context\b/i.test(text)
    || /^Deep workbench-level distillation\./i.test(text)
    || /\btopic workbench\b/i.test(text);
}

function isPointerOrProcessSummary(value) {
  const text = String(value || '').trim();
  return /(?:^|\n)\s*[-*]\s*Workbench:\s+user\/workbenches\//i.test(text)
    || looksLikeBulletListCurrentRead(text)
    || looksLikeThinNewsletterSummary(text)
    || /^##\s+(Current Question|Open Decisions|Next Action)\b/i.test(text)
    || /\bNot relevant:/i.test(text)
    || /\b(resolve|inspect)\b.+\b(workbench|source materials|source roots|topic context)\b/i.test(text)
    || /\bdurable conclusions belong\b/i.test(text)
    || /\bSource of truth for\b/i.test(text)
    || /\bWhen updating:/i.test(text)
    || /pipeline rendering path for compatibility/i.test(text)
    || /\bDistillation Contract\b/i.test(text)
    || /\bMinimum Boot\b/i.test(text)
    || /\bCanonical target:/i.test(text)
    || /Catch-all canonical/i.test(text)
    || /deep work is mastered by/i.test(text)
    || /\bholds compact reusable .* memory and points back here\b/i.test(text)
    || /\bTreat any artifact mentioning\b/i.test(text);
}

function shouldPreferKnownFallback(title, sections, currentRead) {
  if (!hasSpecificFallback(title, sections)) return false;
  const text = String(currentRead || '').trim();
  // For a known topic/workbench, the curated owner-lens intro is the
  // authoritative lead — it opens "{Topic} is your ..." and frames the page from
  // the owner's stance. The raw SYNTHESIS/INDEX opening is a working artifact and
  // should not lead, so prefer the curated fallback UNLESS the file already opens
  // with that same owner-lens frame ("{Title} is your ..."), in which case the
  // file text is already the intended voice and we keep it.
  const alreadyOwnerLensLead = new RegExp(`^${escapeRegExp(String(title || '').trim())}\\s+is\\s+your\\b`, 'i').test(text);
  if (alreadyOwnerLensLead) return false;
  return true;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeBulletListCurrentRead(value) {
  const text = String(value || '').trim();
  if (!/^\s*[-*]\s+/.test(text)) return false;
  const markers = (text.match(/(?:^|\n|\s)\s*[-*]\s+/g) || []).length;
  return markers > 1 || text.length > 240;
}

function looksLikeThinNewsletterSummary(value) {
  const text = String(value || '').trim();
  if (/^You use\b/i.test(text)) return false;
  return text.length < 260 && /newsletters|mailing lists|media digests|market digests/i.test(text);
}

function isPathForwardSummary(value) {
  const text = String(value || '');
  const pathHits = (text.match(/(?:~\/robotdojo\/|user\/(?:contexts|workbenches)\/|(?:INDEX|SYNTHESIS|LOG|context)\.md)/gi) || []).length;
  return pathHits >= 2 || (pathHits >= 1 && text.length < 500);
}

function assembleCurrentReadFromSections(kind, sections) {
  const patterns = kind === 'workbench'
    ? [/latest thinking/i, /latest state/i, /current question/i, /next action/i, /open decisions/i]
    : kind === 'topic'
      ? [/what this topic covers/i, /latest state/i, /current read/i, /summary/i]
      : [];
  const chosen = [];
  const seen = new Set();
  for (const pattern of patterns) {
	    const section = findSection(sections, pattern);
	    if (!section || seen.has(section.title) || !hasMeaningfulMarkdown(section.content)) continue;
	    const content = displayProjectionMarkdown(section.content);
	    if (isUnhumanCurrentRead(normalizeMarkdownBody(content), kind)) continue;
	    chosen.push(`## ${section.title}\n\n${content}`);
	    seen.add(section.title);
	    if (chosen.join('\n\n').length > 900) break;
	  }
	  return chosen.join('\n\n');
}

function fallbackCurrentRead(kind, title, sections = []) {
  const key = normalizedTopicKey(title, sections);
  if (/robot dojo|robot-dojo/.test(key)) {
    return 'Robot Dojo is your product workbench for the system itself: agent behavior, app surfaces, launch readiness, workbench design, and recovery-proof backup work. It makes the state of the product, the active decision pressure, and the next move visible without digging through story files.';
  }
  if (/career|ecede903/.test(key)) {
    return 'Career is your live application layer for the next professional chapter: role criteria, target companies, founder/culture floor, outreach posture, runway, and the current hard constraint. Coaching holds the deeper psychology; this page holds the facts and decisions that change the search.';
  }
  if (/\bdeca\b/.test(key)) {
    return 'Deca is the live professional seat under evaluation: data-center land development, the COO/CAIO mandate, deal economics, and whether the role is real enough to take. It holds the current thesis, the open commercial questions, and the next move before any engagement is agreed.';
  }
  if (/coaching/.test(key)) {
    return 'Coaching is your long-running self-understanding layer: mentors, frameworks, old patterns, and the deeper material behind career and life decisions. The useful read is what the sessions changed about how you see yourself and choose.';
  }
  if (/health/.test(key)) {
    return 'Health is your private clinical layer: symptoms, labs, medications, decisions, and questions to carry into care. It preserves what changed, what remains uncertain, and what needs attention next.';
  }
  if (/\bhome\b|wk home/.test(key)) {
    return 'Home is your household layer: repairs, renovations, purchases, routines, and the practical decisions that make daily life with family work. It makes the house feel like a lived place, not a maintenance queue.';
  }
  if (/family/.test(key)) {
    return 'Family is your living context around partner, child, parents, siblings, home, and the decisions that shape daily life. It holds the emotional and practical state of the family, not just names and logistics.';
  }
  if (/finances/.test(key)) {
    return 'Finances is your family money layer: taxes, CPA work, insurance, banking, investments, retirement accounts, crypto, estate planning, property paperwork, and the quiet obligations that keep the household stable. It makes real decisions and deadlines visible without turning money into a spreadsheet-only story.';
  }
  if (/personal/.test(key)) {
    return 'Personal is your broader life layer: health, learning, hobbies, coaching, family, and the choices that shape how you live outside work. It makes the current life texture visible.';
  }
  if (/user voice/.test(key)) {
    return 'User voice is your writing calibration home: the base register, drift checks, channel rules, document registers, and samples that keep public or private drafts sounding like you. It makes the voice usable, not like a folder index.';
  }
  if (/writing|user voice/.test(key)) {
    return 'Writing is where you turn raw judgment into public language: posts, essays, drafts, voice calibration, and the line between sounding smart and saying something true. It preserves the live argument and your voice, not just draft mechanics.';
  }
  // Owner-specific school/institution prose ships only in the gitignored lens
  // override; tracked code falls through to the generic default below when the
  // lens is empty.
  const lensCurrent = topicLensOverride(key, 'currentRead');
  if (lensCurrent) return lensCurrent;
  if (/learning/.test(key)) {
    return 'Learning is your curiosity engine: technical internals, coding, papers, how-things-work dives, and the side interests you follow. It separates passing fascination from the threads you are actively turning into judgment or skill.';
  }
  if (/networking/.test(key)) {
    return 'Networking is your relationship surface: warm intros, alumni channels, investor conversations, talent partners, operators, and the social capital that makes career and company work move. It distinguishes real doors from ambient contact noise.';
  }
  if (/hobbies/.test(key)) {
    return 'Hobbies is your play and restoration layer: interests that do not need to justify themselves as work, but still reveal what gives you energy, taste, and attention outside the professional arc.';
  }
  if (/\bwork\b|writing/.test(key)) {
    return 'Work is your map of active professional commitments, opportunities, and judgment calls. It makes the stakes visible: what is live, what is over, what deserves attention, and what to ignore.';
  }
  if (/newsletter|\bnl\b|^nl/.test(key)) {
    return `You use ${newsletterStreamTitle(title, key)} as a signal stream, not as a destination. The useful read separates what is actually changing in the world from subscription noise, and names why this stream deserves attention now.`;
  }
  if (/^tc\b|test|maint|tool child|tool parent/.test(key)) {
    return `You are looking at ${humanTopicTitle(title)}, a system/workbench test surface. It has a registered workbench, but it is not meant to carry a felt personal, topic, or entity summary.`;
  }
  return `${humanTopicTitle(title)} has not yet been distilled into a human current read. The useful version names what this ${kind} means to you now, what changed recently, and what deserves attention next.`;
}

function hasSpecificFallback(title, sections = []) {
  const key = normalizedTopicKey(title, sections);
  if (/robot dojo|robot-dojo|career|ecede903|\bdeca\b|coaching|health|\bhome\b|family|finances|personal|writing|user voice|\bwork\b|harvard|columbia|learning|networking|hobbies|newsletter|\bnl\b|^nl/.test(key)) return true;
  // On this box the injected owner lens can add topics beyond the generic set.
  return Boolean(topicLensOverride(key, 'currentRead'));
}

function normalizedTopicKey(title, sections = []) {
  return [title, ...sections.slice(0, 3).map((section) => section.title)]
    .join(' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function humanTopicTitle(title) {
  const cleaned = String(title || 'This page')
    .replace(/^wk[_-]/i, '')
    .replace(/^nl[_-]/i, 'newsletter ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.replace(/\b\w/g, (char) => char.toUpperCase()) || 'This page';
}

function newsletterStreamTitle(title, key) {
  if (/real\s*estate|realestate/.test(key)) return 'real estate newsletters';
  if (/finance/.test(key)) return 'finance newsletters';
  if (/tech/.test(key)) return 'tech newsletters';
  if (/general/.test(key)) return 'general-interest newsletters';
  return `${humanTopicTitle(title).toLowerCase()} newsletters`;
}

function projectCurrentRead(kind, markdown, frontmatter = {}, sections = [], title = '') {
  const text = String(markdown || '').trim();
  if (looksLikePlainMetadataCard(text)) {
    const projected = projectPlainMetadataCard(kind, parsePlainMetadataCardFields(text), frontmatter, title);
    if (projected) return projected;
  }
  if (!looksLikeLegacyDataCard(text)) return relationshipFirstCurrentRead(kind, text, frontmatter, sections);
  const fields = parseLegacyDataCardFields(text);
	  if (kind === 'place' || kind === 'places') {
	    const rawName = frontmatter.display_name || fields.Name || fields.Address || 'This place';
	    const artifact = capturedPlaceArtifact(rawName);
	    const name = displayTitleForKind(rawName, kind);
	    const type = humanPlaceLabel(fields.Type || frontmatter.place_subtype || frontmatter.place_type || 'place');
	    const visits = fields.Visits || '';
	    const first = humanDate(fields['First visited'] || '');
	    const last = humanDate(fields['Last visited'] || '');
    const visitPhrase = visits && visits !== '0'
      ? `You have ${String(visits) === '1' ? 'one captured trace' : `${visits} captured traces`}${last ? `, most recently around ${last}` : ''}.`
      : 'You have a captured trace here, but the surrounding signal is still thin.';
    if (artifact) {
      return [
        `You should not read ${name} as a true place memory; it is a captured ${artifact}.`,
        visitPhrase,
        'Do not read this as a place; the useful memory is probably in the surrounding calendar event, message, or source note.',
      ].filter(Boolean).join('\n\n');
	    }
	    const firstPhrase = first && first !== last ? `The first known trace is ${first}.` : '';
	    const visitCount = Number(String(visits || '').replace(/[^\d.]/g, '')) || 0;
	    const tracePhrase = visitCount === 1
	      ? `You have one known place trace for ${name}${last ? `, around ${last}` : ''}.`
	      : visitCount > 1
	        ? `You have ${visitCount} known place traces for ${name}${last ? `, most recently around ${last}` : ''}.`
	        : `You have a place trace for ${name}, but the visit signal is still thin.`;
	    const meaningfulType = meaningfulPlaceType(type);
	    const typePhrase = meaningfulType
	      ? `The source tags it as ${articleFor(meaningfulType)} ${meaningfulType}, but the page does not yet have enough surrounding context to say what it meant.`
	      : 'The page does not yet have enough surrounding context to say what it meant.';
    return [
      tracePhrase,
      typePhrase,
      firstPhrase,
      'For now, use it as an anchor to recover the surrounding trip, meal, meeting, or errand rather than as a fully felt memory.',
    ].filter(Boolean).join('\n\n');
  }
	  if (kind === 'person' || kind === 'people') {
	    const name = frontmatter.display_name || fields.Name || 'This person';
	    const company = fields.Company || '';
	    const title = fields.Title || '';
	    const role = title && company ? `${title} at ${company}` : title;
	    const known = humanDate(fields['Known since'] || '');
	    const last = humanDate(fields['Last contact'] || '');
	    const opening = personFallbackOpening(name, role, company);
	    const timing = personTimingSentence(known, last);
	    return [
	      opening,
	      timing,
	      'The page still needs more conversation, calendar, or message history before it can carry the warmth of the relationship.',
	    ].filter(Boolean).join('\n\n');
	  }
	  if (kind === 'company' || kind === 'companies') {
	    const name = frontmatter.display_name || fields.Name || 'This company';
	    const vertical = meaningfulCompanyLane(fields.Vertical || fields.Industry || '');
    const people = fields.People || '';
    const fit = companyFitField(fields);
    const technical = fields['Technical bet'] || fields.Mission || '';
	    if (fit || technical) {
	      return [
	        fit ? companyFitLead(name, fit) : companyFallbackOpening(name, vertical),
	        technical || '',
	      ].filter(Boolean).join('\n\n');
	    }
	    if (looksLikeMachineCompanyLabel(name)) {
	      return [
	        companyFallbackOpening(name, vertical),
	        'A linked contact count is not enough to make it meaningful.',
	        'Only promote this page if a real person, decision, purchase, role, or memory attaches to it.',
	      ].join('\n\n');
	    }
	    return [
	      companyFallbackOpening(name, vertical),
	      people ? 'There is enough contact density to treat it as a surface worth resolving, but the count is not the story.' : 'No clear person doorway is attached yet.',
	      'The useful question is what human doorway, decision, memory, or work thread makes this institution matter now.',
	    ].join('\n\n');
	  }
  return text;
}

function lowercaseSentenceStart(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^[A-Z]{2,}\b/.test(text)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function articleFor(value) {
  return /^[aeiou]/i.test(String(value || '')) ? 'an' : 'a';
}

function meaningfulPlaceType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!type || ['place', 'other', 'unknown', 'venue'].includes(type)) return '';
  return type;
}

function looksLikeContactArtifact(value) {
  const text = String(value || '').trim();
  return /@/.test(text) || /^\+?\d[\d\s().-]{7,}$/.test(text) || /^[a-f0-9-]{16,}/i.test(text);
}

function contactArtifactTitle(value) {
  const text = String(value || '').trim();
  const email = text.match(/@([A-Z0-9.-]+\.[A-Z]{2,})/i);
  if (email) return `${organizationFromDomain(email[1])} contact`;
  if (/^\+?\d[\d\s().-]{7,}$/.test(text)) return 'Phone contact artifact';
  return 'Contact artifact';
}

function organizationFromDomain(domain) {
  const host = String(domain || '').toLowerCase().replace(/^www\./, '');
  if (/amazonses\.com$/.test(host)) return 'Amazon SES';
  const base = host.split('.')[0] || 'Unknown';
  return base
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function personFallbackOpening(name, role, company) {
  if (looksLikeContactArtifact(name)) {
    return `This looks like a contact artifact for ${name}${company ? ` through ${company}` : ''}, not yet a felt person page.`;
  }
  if (role) return `You know ${name} as ${role}.`;
  if (company) return `You know ${name} through ${company}.`;
  return `You have a light contact trace for ${name}, but the page does not yet show the relationship clearly.`;
}

function meaningfulCompanyLane(value) {
  const lane = humanLabel(value || '');
  if (!lane || /^(unknown|null|n\/a|na|other)$/i.test(lane)) return '';
  return lane;
}

function companyFitField(fields = {}) {
  const direct = fields['Owner fit'] || fields['User fit'] || fields.Fit || fields.Decision || fields.Outreach || '';
  if (direct) return direct;
  const fitKey = Object.keys(fields).find((key) => /\bfit\b/i.test(key));
  return fitKey ? fields[fitKey] : '';
}

function companyFallbackOpening(name, vertical) {
  if (looksLikeMachineCompanyLabel(name)) {
    return `This looks like an imported company/vendor trace for ${name}, not yet a company you have chosen to care about.`;
  }
  return `${name} is a company or institution trace in your graph${vertical ? ` around ${vertical}` : ''}, but it is not yet a felt company page.`;
}

function companyFitLead(name, fit) {
  const text = String(fit || '').trim();
  if (!text) return companyFallbackOpening(name, '');
  if (/^(?:VP|Head|Director|GM|Chief|Commercial|Product|Operations)\b/i.test(text)) {
    return `For you, ${name} is live because the likely seat is ${text}`;
  }
  return `For you, ${name} matters here because ${lowercaseSentenceStart(text)}`;
}

function relationshipFirstCurrentRead(kind, markdown, frontmatter = {}, sections = []) {
  if (kind === 'person' || kind === 'people') return relationshipFirstPersonRead(markdown, frontmatter);
  if (kind === 'company' || kind === 'companies') return relationshipFirstCompanyRead(markdown, sections, frontmatter);
  if (kind === 'place' || kind === 'places') return relationshipFirstPlaceRead(markdown, frontmatter);
  return markdown;
}

// Prose-style place cards (a written ## Summary, not a legacy data card) still
// embed the raw display_name, which for calendar-derived places is a full
// "Wednesday, February 23, 2022 at 5:30 PM (EST) Venue ... address" string. The
// title is collapsed to the venue name (displayTitleForKind); the current read
// must speak with that same collapsed name, not the date-prefixed original.
// Regenerate the owner-lens read from the venue name + the visit/timing/type
// signals the prose already carries so a date-led sentence never leads.
function relationshipFirstPlaceRead(markdown, frontmatter = {}) {
  const text = String(markdown || '');
  const rawName = frontmatter.display_name
    || text.match(/^#\s+(.+)$/m)?.[1]
    || 'This place';
  const name = displayTitleForKind(rawName, 'places');
  const artifact = capturedPlaceArtifact(rawName);
  if (artifact) {
    return [
      `You should not read ${name} as a true place memory; it is a captured ${artifact}.`,
      'Do not read this as a place; the useful memory is probably in the surrounding calendar event, message, or source note.',
    ].join('\n\n');
  }

  // Visit count from the prose the enricher already wrote. It phrases singular
  // as the word "one" ("You have one known place trace") and plural as a digit
  // ("You have 3 known place traces"), so accept both forms. The H2 "*type | N
  // visits*" is stripped before this runs, so parse from the Summary prose.
  let visitCount = 0;
  const wordOne = /\bone\s+(?:known\s+)?(?:captured\s+)?place\s+trace\b/i.test(text);
  const digitMatch = text.match(/\b(\d+)\s+(?:known\s+|captured\s+)?place\s+traces?\b/i)
    || text.match(/\b(\d+)\s+visits?\b/i);
  if (digitMatch) visitCount = Number(digitMatch[1]);
  else if (wordOne) visitCount = 1;
  // Last-seen: "most recently around <date>" / "around <date>".
  const lastMatch = text.match(/(?:most recently\s+)?around\s+([A-Z][a-z]{2,8}\.?\s+\d{1,2},\s+\d{4})/);
  const last = lastMatch ? lastMatch[1] : '';

  const type = humanPlaceLabel(frontmatter.place_subtype || frontmatter.place_type || 'place');
  const meaningfulType = meaningfulPlaceType(type);

  const tracePhrase = visitCount === 1
    ? `You have one known place trace for ${name}${last ? `, most recently around ${last}` : ''}.`
    : visitCount > 1
      ? `You have ${visitCount} known place traces for ${name}${last ? `, most recently around ${last}` : ''}.`
      : `You have a place trace for ${name}, but the visit signal is still thin.`;
  const typePhrase = meaningfulType
    ? `The source tags it as ${articleFor(meaningfulType)} ${meaningfulType}, but the page does not yet have enough surrounding context to say what it meant.`
    : 'The page does not yet have enough surrounding context to say what it meant.';
  return [
    tracePhrase,
    typePhrase,
    'For now, use it as an anchor to recover the surrounding trip, meal, meeting, or errand rather than as a fully felt memory.',
  ].filter(Boolean).join('\n\n');
}

function relationshipFirstPersonRead(markdown, frontmatter = {}) {
  const namedArtifact = namedPersonContactArtifactRead(markdown, frontmatter);
  if (namedArtifact) return namedArtifact;
  const artifact = nonPersonArtifactRead(markdown, frontmatter);
  if (artifact) return artifact;
  const paragraphs = markdownParagraphs(markdown);
  if (!paragraphs.length) return ownerLensPersonRead(markdown, frontmatter);
  const firstIndex = paragraphs.findIndex((paragraph) => !isThinLeadMetadataParagraph(paragraph));
  if (firstIndex < 0) return ownerLensPersonRead(markdown, frontmatter);
  const first = paragraphs[firstIndex];
  const relationshipIndex = paragraphs.findIndex((paragraph, index) =>
    index > firstIndex
    && hasPersonRelationshipSignal(paragraph));
  if ((relationshipIndex < 0 || relationshipIndex === firstIndex) && looksLikeBioOpening(first)) {
    const reorderedFirst = relationshipFirstOpeningParagraph(first);
    if (reorderedFirst !== first) {
      return ownerLensPersonRead([
        ...paragraphs.slice(0, firstIndex),
        reorderedFirst,
        ...paragraphs.slice(firstIndex + 1),
      ].join('\n\n'), frontmatter);
    }
  }
  if (relationshipIndex < 0) return ownerLensPersonRead(markdown, frontmatter);
  if (!looksLikeBioOpening(first)) return ownerLensPersonRead(markdown, frontmatter);
  const relationship = paragraphs[relationshipIndex];
  const remaining = paragraphs.filter((_, index) => index !== relationshipIndex);
  return ownerLensPersonRead([relationship, ...remaining].join('\n\n'), frontmatter);
}

function namedPersonContactArtifactRead(markdown, frontmatter = {}) {
  const heading = String(markdown || '').match(/^#\s+(.+)$/m)?.[1] || '';
  const name = frontmatter.display_name || frontmatter.name || heading;
  if (!looksLikeContactArtifact(name)) return '';
  const label = contactArtifactTitle(name);
  return [
    `You should not read ${label} as a felt person page yet.`,
    'It may point to a real colleague, shared inbox, or imported contact, but the page does not yet know the human behind the artifact.',
    'The useful memory is the surrounding work thread that produced the contact, not the address or number itself.',
  ].join('\n\n');
}

function ownerLensPersonRead(markdown, frontmatter = {}) {
  let text = String(markdown || '').trim();
  if (!text) return text;
  const subjectName = String(frontmatter.display_name || '').trim();
  const subjectFirst = subjectName.split(/\s+/)[0] || '';
  const ownerNames = ownerDisplayNameCandidates(frontmatter);

  text = text
    .replace(/\bthe user's\b/gi, 'your')
    .replace(/\bthe user has\b/gi, 'you have')
    .replace(/\bthe user is\b/gi, 'you are')
    .replace(/\bthe user was\b/gi, 'you were')
    .replace(/\bthe user\b/gi, 'you');

  text = applyOwnerNameLens(text, ownerNames, subjectName);

  text = ownerLensPersonOpening(text, subjectName, subjectFirst);

  if (subjectName && !/\b(you|your)\b/i.test(stripMarkdownInline(text).slice(0, 220))) {
    text = text
      .replace(/^Pre-call read:/i, `Your read on ${subjectName} changed after the call. Pre-call read:`)
      .replace(new RegExp(`^${escapeRegExp(subjectFirst)}\\s+is\\s+a\\s+\\*\\*core personal contact\\*\\*`, 'i'), `You have ${subjectName} as a **core personal contact**`)
      .replace(new RegExp(`^${escapeRegExp(subjectName)}\\s+is\\s+a\\s+\\*\\*core personal contact\\*\\*`, 'i'), `You have ${subjectName} as a **core personal contact**`)
      .replace(/^\*\*This is not a genuine professional relationship\.\*\*/i, `You should not read ${subjectName} as a genuine professional relationship.`)
      .replace(/^This is not a genuine professional relationship\./i, `You should not read ${subjectName} as a genuine professional relationship.`)
      .replace(/^The relationship\b/i, `Your relationship with ${subjectName}`)
      .replace(/^This relationship\b/i, `Your relationship with ${subjectName}`);
  }

  return text;
}

function ownerDisplayNameCandidates(frontmatter = {}) {
  const globalOwner =
    (typeof globalThis !== 'undefined' && globalThis.ROBOTDOJO_OWNER_DISPLAY_NAME)
    || (typeof window !== 'undefined' && window.ROBOTDOJO_OWNER_DISPLAY_NAME)
    || '';
  return [
    frontmatter.owner_display_name,
    frontmatter.owner_name,
    frontmatter.user_display_name,
    frontmatter.user_name,
    globalOwner,
  ]
    .map((value) => String(value || '').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index);
}

function applyOwnerNameLens(text, ownerNames = [], subjectName = '') {
  let value = String(text || '');
  const subject = String(subjectName || '').trim().toLowerCase();
  for (const ownerName of ownerNames) {
    const name = String(ownerName || '').trim();
    if (!name || name.toLowerCase() === subject) continue;
    const first = name.split(/\s+/)[0] || '';
    const names = [name, first].filter((item, index, values) =>
      item && item.length > 1 && values.indexOf(item) === index);
    for (const item of names) {
      const escaped = escapeRegExp(item);
      value = value
        .replace(new RegExp(`\\b${escaped}'s\\b`, 'g'), 'your')
        .replace(new RegExp(`\\bwith ${escaped}\\b`, 'g'), 'with you')
        .replace(new RegExp(`\\bto ${escaped}\\b`, 'g'), 'to you')
        .replace(new RegExp(`\\bfor ${escaped}\\b`, 'g'), 'for you')
        .replace(new RegExp(`\\bbetween ${escaped} and\\b`, 'g'), 'between you and')
        .replace(new RegExp(`\\b${escaped} and\\b`, 'g'), 'you and')
        .replace(new RegExp(`\\b${escaped} has\\b`, 'g'), 'you have')
        .replace(new RegExp(`\\b${escaped} had\\b`, 'g'), 'you had')
        .replace(new RegExp(`\\b${escaped} is\\b`, 'g'), 'you are')
        .replace(new RegExp(`\\b${escaped} was\\b`, 'g'), 'you were')
        .replace(new RegExp(`\\b${escaped} engaged\\b`, 'g'), 'you engaged')
        .replace(new RegExp(`\\b${escaped} received\\b`, 'g'), 'you received')
        .replace(new RegExp(`\\b${escaped}\\b`, 'g'), 'you');
    }
  }
  return value;
}

function ownerLensPersonOpening(text, subjectName, subjectFirst) {
  if (!subjectName) return text;
  const escapedName = escapeRegExp(subjectName);
  const escapedFirst = escapeRegExp(subjectFirst || subjectName);
  const roleCompany = text.match(new RegExp(`^\\*\\*([^*,\\n]+),\\s*([^*\\n]+)\\*\\*\\s+${escapedName}\\s+is\\s+the\\s+[\\s\\S]+?\\.\\s+In this role,\\s+(she|he|they)\\s+`, 'i'));
  if (roleCompany) {
    const [, role, company, pronoun] = roleCompany;
    const rest = text.slice(roleCompany[0].length);
    const sentencePronoun = pronoun.toLowerCase() === 'they' ? 'They' : pronoun.charAt(0).toUpperCase() + pronoun.slice(1).toLowerCase();
    return `You know ${subjectName} through ${company.trim()} as **${role.trim()}**. ${sentencePronoun} ${rest}`;
  }
  const primaryPoint = new RegExp(`^${escapedFirst}\\s+is\\s+the\\s+primary point of contact between (?:you|[A-Z][A-Za-z'-]+) and`, 'i');
  if (primaryPoint.test(text)) {
    return text.replace(primaryPoint, `You know ${subjectName} as the primary point of contact between you and`);
  }
  return text;
}

function nonPersonArtifactRead(markdown, frontmatter = {}) {
  const text = stripMarkdownInline(markdown).replace(/\s+/g, ' ').trim();
  const name = frontmatter.display_name || frontmatter.name || 'This entry';
  if (!/not a person|automated|newsletter|digest|reporting system|subscriber digest/i.test(text.slice(0, 520))) return '';
  if (/dmarc|aggregate report|reporting system/i.test(text)) {
    return [
      `You should not read ${name} as a person in your network; it is an automated email-authentication artifact for your domain.`,
      'You receive it because a DMARC reporting address is configured for a domain you control, so mail providers send periodic SPF, DKIM, and DMARC pass/fail reports.',
      'The useful question is operational, not relational: keep the reports if you are monitoring deliverability or spoofing, otherwise remove the DMARC reporting address and let this page stay quiet.',
    ].join('\n\n');
  }
  if (/newsletter|digest/i.test(text)) {
    return [
      `You should not read ${name} as a person in your network; it is a captured newsletter or digest stream.`,
      'Read it as an information source only if it consistently changes your judgment. Otherwise it belongs in the subscription-noise bucket, not in the relationship map.',
    ].join('\n\n');
  }
  return `You should not read ${name} as a person in your network. You have a captured automated artifact here, and the useful memory is the operational reason it keeps arriving, not a relationship to maintain.`;
}

function isThinLeadMetadataParagraph(paragraph) {
  const text = String(paragraph || '').trim();
  return text.length < 180
    && /^\*[^*]+\*$/.test(text)
    && /@|·|—|>|Core|Family|Professional|Personal|Company/i.test(text);
}

function hasPersonRelationshipSignal(value) {
  return /(you'?ve known|connected with|connection with|relationship|current active thread|most recent contact|recent contact|near-term|near term|intro|introduction|workshop|trip|call|meeting|follow-up|follow up|proactively shared|reached out|offboarded|last working day|departing|left .*company|moved into a new role|primary point of contact|between (?:you|[A-Z][A-Za-z'-]+) and|with (?:you|[A-Z][A-Za-z'-]+)|copied (?:you|[A-Z][A-Za-z'-]+)|brought into .*orbit|introduced .*to|proposal moved forward|internal advocate)/i.test(String(value || ''));
}

function relationshipFirstOpeningParagraph(paragraph) {
  const direct = extractRelationshipSignalSentence(paragraph);
  if (direct && direct.index > 24) {
    const before = paragraph.slice(0, direct.index).trim();
    const after = paragraph.slice(direct.index + direct.sentence.length).trim();
    return [direct.sentence, before, after].filter(Boolean).join(' ');
  }
  const sentences = splitSentences(paragraph);
  if (sentences.length < 2) return paragraph;
  const index = sentences.findIndex((sentence, i) => i > 0 && hasPersonRelationshipSignal(sentence));
  if (index < 0) return paragraph;
  const [lead] = sentences.splice(index, 1);
  return [lead, ...sentences].join(' ');
}

function extractRelationshipSignalSentence(paragraph) {
  const text = String(paragraph || '');
  const pattern = /([^.!?]*(?:primary point of contact|between (?:you|[A-Z][A-Za-z'-]+) and|with (?:you|[A-Z][A-Za-z'-]+)|copied (?:you|[A-Z][A-Za-z'-]+)|brought into [^.!?]*orbit|introduced [^.!?]*to|proposal moved forward|internal advocate|connection with|connected with|offboarded|last working day)[^.!?]*[.!?])/i;
  const match = text.match(pattern);
  return match ? { sentence: match[1].trim(), index: match.index } : null;
}

function splitSentences(paragraph) {
  return String(paragraph || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?])\s+(?=[A-Z*\["“])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function relationshipFirstCompanyRead(markdown, sections = [], frontmatter = {}) {
  const paragraphs = markdownParagraphs(markdown);
  const fit = sectionByTitle(sections, /owner fit|fit for role|specific seat|decision|outreach|warm-intro|warm intro/i);
  if (fit && !sameOrPrefixMarkdown(fit.content, markdown)) {
    const summary = trimMarkdown(displayProjectionMarkdown(fit.content), 1000);
    const rest = paragraphs.join('\n\n');
    return ownerLensCompanyRead([summary, rest].filter(Boolean).join('\n\n'), frontmatter);
  }
  return ownerLensCompanyRead(markdown, frontmatter);
}

function ownerLensCompanyRead(markdown, frontmatter = {}) {
  let text = String(markdown || '').trim();
  if (!text) return text;
  text = text
    .replace(/\bOwner's\b/g, 'your')
    .replace(/\bOwner is\b/g, 'you are')
    .replace(/\bOwner has\b/g, 'you have')
    .replace(/\bOwner lands\b/g, 'you land')
    .replace(/\bthe owner's\b/gi, 'your')
    .replace(/\bthe owner\b/gi, 'you');
  const first = stripMarkdownInline(text).replace(/\s+/g, ' ').trim().slice(0, 320);
  const referral = cleanMetadataValue(frontmatter.referral);
  if (/\b(you|your)\b/i.test(first)) return text;
  if (referral) {
    const name = frontmatter.display_name || frontmatter.name || companyNameFromDescription(text) || 'this company';
    return `For you, ${name} enters the map through ${referral}. ${text}`;
  }
  if (!hasCompanyFitSignal(text)) return text;
  return `For you, ${companyLeadClause(text)}`;
}

function hasCompanyFitSignal(value) {
  return /\b(fit|role|seat|VP|Head of|Commercial|BD|Business Development|GM|mission|warm intro|target|hire|reports to|comp|geography|blocker|entry|thesis|customer|enterprise|operator|background|referral|referred by)\b/i.test(String(value || ''));
}

function companyLeadClause(value) {
  const text = String(value || '').trim();
  if (/^[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/.test(text)) return text;
  return lowercaseSentenceStart(text);
}

function sectionByTitle(sections, pattern) {
  return sections.find((section) => pattern.test(section.title) && hasMeaningfulMarkdown(section.content)) || null;
}

function markdownParagraphs(markdown) {
  return String(markdown || '')
    .replace(/^#\s+.+(?:\r?\n)+/, '')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function stripMarkdownInline(markdown) {
  return String(markdown || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#+\s+/gm, '')
    .trim();
}

function looksLikeBioOpening(markdown) {
  const first = stripMarkdownInline(markdown).replace(/\s+/g, ' ').trim().slice(0, 240);
  return /\s(?:is|appears|operates|serves|currently appears)\b/i.test(first);
}

const PLAIN_METADATA_KEYS = new Set([
  'description',
  'website',
  'funding_stage',
  'total_raised',
  'lead_investors',
  'employee_range',
  'company',
  'current_role',
  'location',
  'linkedin_url',
  'twitter',
]);

function looksLikePlainMetadataCard(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const hits = lines
    .map((line) => plainMetadataLine(line))
    .filter(Boolean);
  return hits.length >= 2 || hits.some((hit) => hit.key === 'description');
}

function plainMetadataLine(line) {
  const match = String(line || '').match(/^\s*([a-z][a-z0-9_-]{1,32}):\s*(.*?)\s*$/i);
  if (!match) return null;
  const key = match[1].trim().toLowerCase();
  if (!PLAIN_METADATA_KEYS.has(key)) return null;
  return { key, value: match[2].trim() };
}

function parsePlainMetadataCardFields(markdown) {
  const fields = {};
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const hit = plainMetadataLine(line);
    if (hit) fields[hit.key] = hit.value;
  }
  return fields;
}

function projectPlainMetadataCard(kind, fields, frontmatter = {}, title = '') {
  if (kind === 'person' || kind === 'people') return plainPersonRead(fields, frontmatter, title);
  if (kind === 'company' || kind === 'companies') return plainCompanyRead(fields, frontmatter, title);
  return '';
}

function plainPersonRead(fields, frontmatter = {}, title = '') {
  const name = frontmatter.display_name || title || 'This person';
  const role = cleanMetadataValue(fields.current_role);
  const company = cleanMetadataValue(fields.company);
  const location = cleanMetadataValue(fields.location);
  const rolePhrase = role || (company ? `a trace through ${company}` : '');
  const subject = firstNameOrThey(name);
  const matters = subject === 'they' ? 'why they matter now' : `why ${subject} matters now`;
  const placePhrase = location ? ` in ${location}` : '';
  return [
    rolePhrase
      ? `You have a thin trace for ${name}: ${rolePhrase}${placePhrase}.`
      : `You have a thin trace for ${name}, but the page does not yet show the relationship clearly.`,
    `The human part is still missing: how ${subject} entered your world, whether there is a real relationship, and ${matters}.`,
    'Until that context is added, read this as a doorway to recover the relationship rather than a finished person page.',
  ].join('\n\n');
}

function plainCompanyRead(fields, frontmatter = {}, title = '') {
  const name = frontmatter.display_name || title || companyNameFromDescription(fields.description) || 'This company';
  const description = cleanCompanyDescription(fields.description, name);
  const funding = [
    cleanMetadataValue(fields.funding_stage),
    cleanMetadataValue(fields.total_raised) ? `${cleanMetadataValue(fields.total_raised)} raised` : '',
    cleanMetadataValue(fields.lead_investors) ? `led by ${cleanMetadataValue(fields.lead_investors)}` : '',
  ].filter(Boolean).join(', ');
  const size = cleanMetadataValue(fields.employee_range);
  const signal = [funding, size ? `${size} employees` : ''].filter(Boolean).join('; ');
  if (!description && looksLikeMachineCompanyLabel(name)) {
    return [
      `This looks like an imported company/vendor trace for ${name}, not yet a company you have chosen to care about.`,
      signal ? `The outside signal is thin: ${signal}.` : '',
      'The useful question is whether a real person, decision, purchase, role, or memory attaches to it. Until then, the page stays quiet instead of pretending the trace is a relationship.',
    ].filter(Boolean).join('\n\n');
  }
  return [
    description
      ? `${name} is on your radar as ${lowercaseSentenceStart(description)}`
      : `${name} is on your company radar, but the page does not yet know the real story.`,
    signal ? `The outside signal is real: ${signal}.` : '',
    'The missing piece is the human doorway: who opens it for you, whether it fits the work you are choosing now, and why this company matters at this moment.',
  ].filter(Boolean).join('\n\n');
}

function cleanMetadataValue(value) {
  const text = String(value || '').trim();
  if (!text || /^(unknown|null|n\/a|na)$/i.test(text)) return '';
  return text;
}

function companyNameFromDescription(value) {
  const match = String(value || '').trim().match(/^([A-Z][A-Za-z0-9&.'-]+(?:\s+[A-Z][A-Za-z0-9&.'-]+){0,4})\s+is\b/);
  return match ? match[1].trim() : '';
}

function cleanCompanyDescription(value, name = '') {
  let text = cleanMetadataValue(value)
    .replace(/\s+Categories:.*$/i, '')
    .replace(/\s+\d+\s+funding rounds?.*$/i, '')
    .replace(/\s+Private,\s*active\.?$/i, '')
    .trim();
  if (name) {
    const re = new RegExp(`^${escapeRegExp(name)}\\s+is\\s+`, 'i');
    text = text.replace(re, '');
  }
  if (text && !/[.!?]$/.test(text)) text += '.';
  return text;
}

function firstNameOrThey(name) {
  const first = String(name || '').trim().split(/\s+/)[0];
  return first && !/^This$/i.test(first) ? first : 'they';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeLegacyDataCard(markdown) {
  const text = String(markdown || '');
  return /\*\*(Type|Visits|Address|Email|Company|Title|Industry|People|Vertical):\*\*/i.test(text)
    || /structured data only|context — structured data/i.test(text);
}

function looksLikeImportedDataCard(markdown) {
  return looksLikeLegacyDataCard(markdown) || looksLikePlainMetadataCard(markdown);
}

function looksLikeMachineCompanyLabel(value) {
  const label = humanLabel(value || '');
  return /^\d{5,}m\b/i.test(label)
    || /@/.test(label)
    || /\b(?:hubspotemail|envoyglobal|sendgrid|mailgun|amazonses|mktomail|sfmc|mailchimp|mailchimpapp|sparkpost|sparkpostmail|noreply|no reply|donotreply)\b/i.test(label);
}

function parseLegacyDataCardFields(markdown) {
  const fields = {};
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const match = line.match(/^\*\*([^:*]+):\*\*\s*(.+?)\s*$/);
    if (match) fields[match[1].trim()] = match[2].trim();
  }
  return fields;
}

function humanLabel(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function humanPlaceLabel(value) {
  const label = humanLabel(value || 'place').toLowerCase();
  if (label === 'virtual') return 'virtual meeting link';
  return label;
}

function humanDate(value) {
  const raw = String(value || '').trim();
  if (!raw || /^(unknown|null|n\/a|na)$/i.test(raw)) return '';
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})(.*)$/);
  if (!match) return raw;
  const date = new Date(`${match[1]}T00:00:00`);
  if (Number.isNaN(date.getTime())) return raw;
  return `${date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}${match[2] || ''}`;
}

function personTimingSentence(known, last) {
  if (known && last && known === last) {
    return `The only clear timing signal is a touch around ${last}.`;
  }
  if (known && last) {
    return `The relationship spans from around ${known} to the latest clear touch around ${last}.`;
  }
  if (last) return `The latest clear touch is around ${last}.`;
  if (known) return `The first clear trace is around ${known}.`;
  return '';
}

function displayTitleForKind(title, kind) {
  const raw = /^(place|places)$/i.test(String(kind || ''))
    ? cleanPlaceDisplayName(title)
    : String(title || '').trim();
  if (/^(person|people)$/i.test(String(kind || '')) && looksLikeContactArtifact(raw)) {
    return contactArtifactTitle(raw);
  }
  if (!/^(place|places)$/i.test(String(kind || ''))) return raw;
  const addressStart = raw.search(/\s+\d{1,6}\s+[A-Z0-9]/);
  if (addressStart <= 0) return raw;
  const name = raw.slice(0, addressStart).trim().replace(/[,\s]+$/, '');
  return name.length >= 8 ? name : raw;
}

function cleanPlaceDisplayName(value) {
  const raw = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return raw;
  if (capturedPlaceArtifact(raw) === 'Zoom invitation') return 'Zoom meeting invitation';
  if (capturedPlaceArtifact(raw) === 'scheduling link') return 'Scheduling link';
  if (capturedPlaceArtifact(raw) === 'web link') return 'Captured web link';
  const withoutCalendarPrefix = raw
    .replace(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+[A-Za-z]+\s+\d{1,2},\s+\d{4}\s+at\s+\d{1,2}:\d{2}\s*(?:AM|PM)?\s*(?:\([A-Z]{2,4}\))?\s*/i, '')
    .trim();
  const cleaned = withoutCalendarPrefix || raw;
  const display = cleaned
    .replace(/,\s*when you dine at restaurants worldwide.*$/i, '')
    .replace(/\s+Terms apply\..*$/i, '')
    .replace(/\s+As a valued guest,.*$/i, '')
    .replace(/,\s*How likely are you.*$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[,\s]+$/, '')
    .trim();
  const comma = display.indexOf(',');
  const lead = comma > 3 ? display.slice(0, comma).trim() : '';
  const tail = comma > 3 ? display.slice(comma + 1).trim() : '';
  const addressTail = /^(?:\d|Carretera|Parcela|Street|St\.?|Road|Rd\.?|Avenue|Ave\.?|Boulevard|Blvd\.?|Drive|Dr\.?|Lane|Ln\.?|Way|Highway|Hwy\.?|Suite|Unit|Apt\.?)\b/i.test(tail);
  return lead && addressTail ? lead : display;
}

function capturedPlaceArtifact(value) {
  const text = String(value || '');
  if (/scheduled Zoom meeting|Join Zoom Meeting|zoom\.us\/|Meeting ID:|Passcode:|uuid=WN_/i.test(text)) {
    return 'Zoom invitation';
  }
  if (/acuityscheduling\.com|calendly\.com|action=meet|apptID=/i.test(text)) return 'scheduling link';
  if (/^(?:URL:\s*)?https?:\/\//i.test(text)) return 'web link';
  return '';
}

function selectWorkingBriefMarkdown(kind, sections, markdown, currentRead = '', frontmatter = {}, title = '') {
  if (isEntityKind(kind)) {
    const sourceBrief = entitySourceWorkingBrief(kind, sections, frontmatter, title);
    if (sourceBrief) return sourceBrief;
  }

  const preferred = [];
  if (kind === 'workbench') {
    preferred.push(/latest state/i, /latest thinking/i, /current question/i, /next action/i, /open questions/i, /open decisions/i, /unresolved questions/i, /distillation contract/i);
  } else if (kind === 'person' || kind === 'people') {
    preferred.push(/profile/i, /connection/i, /reconnection call/i, /read on/i);
  } else if (kind === 'company' || kind === 'companies') {
    preferred.push(/what (?:they|the company) do(?:es)?/i, /technical bet/i, /stage/i, /leadership/i, /fit/i, /risk/i);
  } else if (kind === 'agent') {
    preferred.push(/identity/i, /capabilities/i, /failure modes/i, /quality bar/i, /mentor/i, /north star/i);
  } else {
    preferred.push(/summary/i, /history/i, /latest/i);
  }

  const selected = [];
  const seenTitles = new Set();
  for (const pattern of preferred) {
    const section = findSection(sections, pattern);
    if (
      section
      && !seenTitles.has(section.title)
      && !isProjectionNoiseSection(section.title)
      && !(isEntityKind(kind) && /summary/i.test(section.title) && looksLikeImportedDataCard(section.content))
    ) {
      selected.push(`## ${section.title}\n\n${displayProjectionMarkdown(section.content)}`);
      seenTitles.add(section.title);
    }
  }
	  if (!selected.length && isEntityKind(kind)) {
	    const alternate = alternateBriefSections(kind, sections, currentRead);
	    return alternate ? trimMarkdown(cleanWorkingBriefMarkdown(alternate), 4200) : '';
	  }
	  const source = selected.length ? selected.join('\n\n') : displayProjectionMarkdown(stripLeadingTitle(markdown));
	  const brief = trimMarkdown(source, 4200);
	  if (sameMarkdownBody(brief, currentRead) || sameOrPrefixMarkdown(brief, currentRead)) {
	    const alternate = alternateBriefSections(kind, sections, currentRead);
	    return sameMarkdownBody(alternate, currentRead) || sameOrPrefixMarkdown(alternate, currentRead) ? '' : trimMarkdown(cleanWorkingBriefMarkdown(alternate), 4200);
	  }
	  return trimMarkdown(cleanWorkingBriefMarkdown(brief), 4200);
}

function entitySourceWorkingBrief(kind, sections, frontmatter = {}, title = '') {
  const picked = [];
  const seen = new Set();
  const patterns = [/summary/i, /connection/i, /profile/i, /read on/i, /reconnection call/i];
  for (const pattern of patterns) {
    const section = findSection(sections, pattern);
    if (
      !section
      || seen.has(section.title)
      || !hasMeaningfulMarkdown(section.content)
      || isProjectionNoiseSection(section.title)
      || isBriefExcludedEntitySection(kind, section)
      || looksLikeImportedDataCard(section.content)
    ) {
      continue;
    }
    const projected = projectCurrentRead(kind, section.content, frontmatter, sections, title);
    const cleaned = displayProjectionMarkdown(projected);
    if (!hasMeaningfulMarkdown(cleaned)) continue;
    const heading = workingBriefSectionHeading(section.title, title, frontmatter);
    picked.push([heading, cleaned].filter(Boolean).join('\n\n'));
    seen.add(section.title);
  }
  const brief = cleanWorkingBriefMarkdown(picked.join('\n\n'));
  return trimMarkdown(brief, 4200);
}

function workingBriefSectionHeading(sectionTitle, title = '', frontmatter = {}) {
  const raw = String(sectionTitle || '').trim();
  if (!raw || /^summary$/i.test(raw)) return '';
  const canonical = String(frontmatter.display_name || title || '').trim();
  if (sameLooseTitle(raw, canonical)) return '';
  return `## ${raw}`;
}

function ensureHumanWorkingBrief(kind, title, brief, currentRead = '', sections = []) {
  const text = String(brief || '').trim();
  if (!text) return fallbackWorkingBrief(kind, title, currentRead, sections, text);
  if (normalizeMarkdownBody(text).length < 100) return fallbackWorkingBrief(kind, title, currentRead, sections, text);

  if (isEntityKind(kind) && looksLikeContactArtifactRead(currentRead)) {
    return fallbackWorkingBrief(kind, title, currentRead, sections, text);
  }

  if (/^(topic|workbench)$/i.test(String(kind || '')) && looksLikeWorkbenchMechanicsBrief(text)) {
    return fallbackWorkingBrief(kind, title, currentRead, sections, text);
  }

  const sourceExpansion = isEntityKind(kind) && expandsCurrentRead(text, currentRead);
  if (looksLikePointerOnlyBrief(text) || (!sourceExpansion && (sameOrPrefixMarkdown(text, currentRead) || overlapsCurrentRead(text, currentRead)))) {
    return fallbackWorkingBrief(kind, title, currentRead, sections, text);
  }

  if (isEntityKind(kind) && looksLikeImportedEntityBrief(kind, text)) {
    return fallbackWorkingBrief(kind, title, currentRead, sections, text);
  }

  if (looksLikeDetachedPersonBrief(kind, title, text, currentRead)) {
    return fallbackWorkingBrief(kind, title, currentRead, sections, text);
  }

  if (looksLikeMechanicalBulletBrief(text)) {
    if (/^(topic|workbench)$/i.test(String(kind || ''))) {
      return fallbackWorkingBrief(kind, title, currentRead, sections, text);
    }
    const narrative = narrativeBriefFromBullets(text);
    if (hasMeaningfulMarkdown(narrative)) return trimMarkdown(narrative, 4200);
    return fallbackWorkingBrief(kind, title, currentRead, sections, text);
  }

  if (looksLikeMechanicalBriefHeading(text) && /^(topic|workbench)$/i.test(String(kind || ''))) {
    const withoutHeading = text
      .replace(/^##\s+(?:Latest Thinking \/ Decisions|Current Thesis|Summary|Open Questions \/ Next Steps)\s*/i, '')
      .trim();
    if (withoutHeading && !looksLikeMechanicalBulletBrief(withoutHeading) && !looksLikePointerOnlyBrief(withoutHeading)) {
      return trimMarkdown(withoutHeading, 4200);
    }
    return fallbackWorkingBrief(kind, title, currentRead, sections, text);
  }

  return text;
}

function looksLikeMechanicalBriefHeading(markdown) {
  return /^##\s+(?:Latest Thinking \/ Decisions|Current Thesis|Summary|Open Questions \/ Next Steps|Workbench)\b/im.test(String(markdown || ''));
}

function looksLikePointerOnlyBrief(markdown) {
  const text = normalizeMarkdownBody(markdown);
  if (!text) return true;
  return /(?:^|\s)Workbench:\s+user\/workbenches\//i.test(text)
    || /user\/(?:contexts|workbenches)\//i.test(text)
    || /Continue from the newest source-backed synthesis/i.test(text)
    || /Source Watermark|memory_projection|source_event_|source records/i.test(text);
}

function looksLikeWorkbenchMechanicsBrief(markdown) {
  const text = normalizeMarkdownBody(markdown);
  if (!text) return true;
  const mechanics = [
    /Distillation Contract/i,
    /\bPurpose:\s/i,
    /\bCanonical target:\s/i,
    /\bCompact context:\s/i,
    /\bLong synthesis:\s/i,
    /\bRAG substrate:\s/i,
    /\bReview threshold:\s/i,
    /\bMinimum Boot\b/i,
    /\bDeep Links\b/i,
    /\bPromote only durable\b/i,
    /\bsource notes, datasets, renderings\b/i,
    /\b(?:registered as|remains|is not|not a)\b.{0,80}\btopic workbench\b/i,
    /\bboot contract\b/i,
    /user\/workbenches\//i,
    /user\/contexts\//i,
  ];
  return mechanics.some((pattern) => pattern.test(text));
}

function looksLikeImportedEntityBrief(kind, markdown) {
  if (!isEntityKind(kind)) return false;
  const text = String(markdown || '');
  if (looksLikeImportedDataCard(text)) return true;
  if (/context\s+—\s+structured data only|structured data only/i.test(text)) return true;
  if (/^\s*\*?(?:Company|Person|Place)\s*>\s*[^*\n]+\*?\s*$/im.test(text) && /##\s+(?:Summary|History|Key Contacts)\b/i.test(text)) return true;
  if (/##\s+Key Contacts\b/i.test(text) && /(?:^|\n)\s*[-*]\s+(?:\S+@\S+|[^\n]+?\((?:Acquaintance|Core|Network|Family|Professional|Personal)\))/i.test(text)) return true;
  return false;
}

function looksLikeDetachedPersonBrief(kind, title, brief, currentRead) {
  if (!/^(person|people)$/i.test(String(kind || ''))) return false;
  if (!hasPersonRelationshipSignal(currentRead)) return false;
  const lead = stripMarkdownInline(brief).replace(/\s+/g, ' ').trim().slice(0, 520);
  const label = humanTopicTitle(title);
  const first = label.split(/\s+/)[0] || '';
  const startsAsBio = /^([A-Z][\w'’.-]+(?:\s+[A-Z][\w'’.-]+){0,4})\s+(?:is|appears|operates|serves|currently appears)\b/i.test(lead)
    || (first && new RegExp(`^${escapeRegExp(first)}\\b.{0,180}\\b(?:is|appears|serves|associated|affiliated|member|representative|founder|operator|exact title|specific title)\\b`, 'i').test(lead))
    || /^[A-Z][^.!?]{0,180}\b(?:is|appears|serves|associated|affiliated|representative|member|founder|operator|exact title|specific title)\b/i.test(lead)
    || (!/^(?:you|your|the deeper relationship)\b/i.test(lead) && /\b(?:is|appears|serves|associated|affiliated|representative|member|founder|operator|doctor|certified|operates through|specific title|exact title)\b/i.test(lead.slice(0, 320)));
  if (startsAsBio) return true;
  if (/\b(you|your|you've|you have|you know)\b/i.test(lead)) return false;
  return false;
}

function overlapsCurrentRead(brief, currentRead) {
  const left = normalizeMarkdownBody(brief).toLowerCase();
  const right = normalizeMarkdownBody(currentRead).toLowerCase();
  if (!left || !right) return false;
  const probe = right.slice(0, Math.min(160, right.length));
  return probe.length >= 80 && left.slice(0, 700).includes(probe);
}

function expandsCurrentRead(brief, currentRead) {
  const left = normalizeMarkdownBody(brief);
  const right = normalizeMarkdownBody(currentRead);
  if (!left || !right) return false;
  if (left.length < right.length + 80) return false;
  const probe = right.slice(0, Math.min(220, right.length));
  return probe.length >= 120 && left.slice(0, 900).includes(probe);
}

function looksLikeMechanicalBulletBrief(markdown) {
  const text = String(markdown || '');
  const bulletCount = (text.match(/(?:^|\n)\s*[-*]\s+/g) || []).length;
  if (bulletCount >= 2 || (/^##\s+Latest Thinking \/ Decisions\b/im.test(text) && bulletCount >= 1)) return true;
  if (bulletCount === 1) {
    const bullet = text.match(/(?:^|\n)\s*[-*]\s+(.+?)\s*$/m);
    return bullet ? isMechanicalBriefBullet(cleanBulletBriefLine(bullet[1])) : false;
  }
  return false;
}

function narrativeBriefFromBullets(markdown) {
  const bullets = [];
  for (const rawLine of String(markdown || '').split(/\r?\n/)) {
    const match = rawLine.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!match) continue;
    const cleaned = cleanBulletBriefLine(match[1]);
    if (!cleaned || isMechanicalBriefBullet(cleaned)) continue;
    bullets.push(cleaned);
    if (bullets.length >= 5) break;
  }
  return bullets.join('\n\n');
}

function cleanBulletBriefLine(value) {
  return String(value || '')
    .replace(/\s+Source:\s+.+$/i, '')
    .replace(/\*\*/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^\s*Decision[.:]\s*/i, '')
    .replace(/^Why it's right:\s*/i, '')
    .trim();
}

function isMechanicalBriefBullet(value) {
  const text = String(value || '').trim();
  if (text.length < 45) return true;
  return /^(?:approved|yes add it|move to|calendar:|emails:|what did you actually ship|what's the actual decision|give me the angle|read transcripts?|no explicit decisions found|here's the architectural decision|decision source\b)/i.test(text)
    || /^\S+@\S+\s*(?:\([^)]+\))?$/.test(text)
    || /(?:user\/(?:contexts|workbenches)\/|messages:\d+|topic_context_history:\d+|memory_events)/i.test(text)
    || /\b(resolve|inspect)\b.+\b(workbench|source materials|source roots|topic context)\b/i.test(text)
    || /\bdurable .* belong\b/i.test(text);
}

function fallbackWorkingBrief(kind, title, currentRead = '', sections = [], rawBrief = '') {
  const key = normalizedTopicKey(title, sections);
  const specific = fallbackDeepBrief(key);
  if (specific) return specific;
  const entityBrief = fallbackEntityDeepBrief(kind, title, currentRead);
  if (entityBrief) return entityBrief;
  const read = normalizeMarkdownBody(currentRead);
  if (read && !looksLikePointerOnlyBrief(read)) {
    return `The deeper read for ${humanTopicTitle(title)} is the live evidence underneath the 1k read: what changed, what remains unresolved, and what deserves attention next.`;
  }
  const label = humanTopicTitle(title);
  return `The deeper read for ${label} is a living synthesis, not a source list or workbench pointer.`;
}

function fallbackEntityDeepBrief(kind, title, currentRead = '') {
  const label = humanTopicTitle(title);
  if (kind === 'person' || kind === 'people') {
    if (looksLikeContactArtifactRead(currentRead)) {
      return `The deeper read is that ${label} is not yet a person page. It is a contact artifact attached to a work context, and the humane thing is to keep it provisional until the system knows the person behind it.\n\nWhat matters is the surrounding thread: which company, meeting, project, or vendor relationship produced the contact, and whether that thread deserves a real named relationship page later.`;
    }
    if (hasPersonRelationshipSignal(currentRead)) {
      const active = activeRelationshipThread(currentRead);
      return [
        `The deeper read is that ${label} has both history and present-tense motion.${active ? ` ${active}` : ''}`,
        'The relationship matters as trust, timing, and reciprocity, not as a bio. The useful layer is why the next touch is happening, what you can give back, and whether the thread still has warmth after the immediate ask.',
      ].join('\n\n');
    }
    return `The deeper read is that ${label} is still a light relationship trace. The page does not yet have enough conversation, calendar, message, or work history to show how this person entered your world, what changed, and whether anything is still alive.`;
  }
  if (kind === 'company' || kind === 'companies') {
    if (looksLikeMachineCompanyLabel(label)) {
      return `The deeper read is that ${label} is an imported email or vendor-domain trace, not a relationship, target, customer, partner, or company memory.\n\nThe humane version stays restrained until a real doorway appears: a person, decision, work thread, purchase, or memory that explains why this trace deserves attention. Until then, there may be nothing here.`;
    }
    return `The deeper read is that ${label} is still an institution trace, not yet a felt company relationship. Contact density is only a clue; the real doorway is the person, role, customer, partner, purchase, or memory that makes the company matter.\n\nUntil that doorway is visible, the page stays honest about ambiguity instead of pretending a contact cluster is a story.`;
  }
  if (kind === 'place' || kind === 'places') {
    return `The deeper read is that ${label} is a place trace waiting for its surrounding scene. It becomes meaningful when the trip, meal, meeting, errand, routine, or memory comes back into focus; without that context, it is an anchor rather than a fully felt place.`;
  }
  return '';
}

function looksLikeContactArtifactRead(value) {
  return /not read .* as a felt person page yet|contact artifact|imported contact|address or number itself/i.test(String(value || ''));
}

function activeRelationshipThread(currentRead) {
  const text = stripMarkdownInline(currentRead).replace(/\s+/g, ' ').trim();
  if (/\bAustin\b/i.test(text) && /\bintro|introduction|workshop|trip\b/i.test(text)) {
    return 'The live signal is the Austin thread: introductions, workshop possibility, and a practical map through people he can credibly route to.';
  }
  const sentences = splitSentences(text);
  const sentence = sentences.find((part) =>
    /current active thread|near-term|near term|most recent contact|broader goal|Austin trip|workshop|intro|introduction|follow-up|follow up|called to|surfaced/i.test(part)
    && !/\b(?:phone|email)\b/i.test(part));
  if (!sentence) return '';
  return 'The live signal is the current thread: the reason this person deserves attention now, not just the fact that they exist in the graph.';
}

function fallbackDeepBrief(key) {
  if (/robot dojo|robot-dojo/.test(key)) {
    return 'The deeper read is that Robot Dojo is trying to become a first-class intelligence surface, not just a chat app with files behind it. The live pressure is product coherence: stable URLs, relay auth, beautiful markdown rendering, agent memory, and workbench depth all have to feel like one system instead of stitched-together tools.\n\nAt 4k, this preserves product decisions, open risks, and the current shape of the work without making you open story folders. It tells you what is live, what broke trust, what changed recently, and which next move makes the whole system feel more inevitable.';
  }
  if (/career|ecede903/.test(key)) {
    return 'The deeper read is the tension between aspiration and execution: you are trying to find the next professional chapter without shrinking the ambition into a merely plausible role. The page holds target companies, role criteria, founder/culture filters, runway, outreach posture, and the current constraint in one place.\n\nAt 4k, this says where conviction is increasing, where the search is still noisy, and which opportunities deserve social capital now. It connects the external market to your internal pattern work instead of becoming a list of companies.';
  }
  if (/\bdeca\b/.test(key)) {
    return 'The deeper read is whether this seat is real enough to take. Deca is a live professional evaluation: data-center land, the COO/CAIO mandate, deal economics, and the next move before any engagement is agreed.\n\nAt 4k, this keeps the thesis, the open commercial questions, and the split rooms visible: scope on one side, economics on the other. It is a decision surface, not a company wiki.';
  }
  if (/coaching/.test(key)) {
    return 'The deeper read is not a ledger of coaching sessions. It is the running map of how you understand yourself: old loops, mentor frames, confidence, ambition, fear, and the repeated choice to act from the larger version of your own life.\n\nAt 4k, this surfaces what actually changed across sessions: which belief softened, which pattern repeated, and which decision now has a clearer test. The coaching corpus becomes accumulated self-knowledge, not stored transcripts.';
  }
  if (/health/.test(key)) {
    return 'The deeper read is that your health corpus is an engineering-grade clinical system around a real body: labs, symptoms, medications, genetics, supplements, diagnoses, monitoring targets, and a disciplined protocol that keeps the analysis honest.\n\nAt 4k, this preserves what changed, what is still uncertain, and what needs to be carried into care. Clinical state becomes legible without collapsing into lab tables or generic wellness notes.';
  }
  if (/family/.test(key)) {
    return 'The deeper read is the living system around partner, child, parents, siblings, home, care, time, and money. This page holds the real family state: what is stable, what is tender, what is logistically heavy, and what deserves attention before it becomes a crisis.\n\nAt 4k, this connects people to lived obligations and affection. Family feels like the center of gravity, not a contact group.';
  }
  if (/\bhome\b|wk home/.test(key)) {
    return 'The deeper read is the house as a lived operating system. Repairs, renovations, purchases, routines, contractors, weather, and permitting all matter because they shape daily life for the family inside the house.\n\nAt 4k, this keeps the practical state visible without turning home into a maintenance queue. It says what changed, what needs a decision, and how the house is becoming more livable.';
  }
  if (/finances/.test(key)) {
    return 'The deeper read is the family money layer as one connected system: taxes, CPA work, insurance, banking, investments, retirement accounts, crypto, estate planning, property paperwork, and the quiet obligations that keep options open.\n\nAt 4k, this shows decisions and deadlines, not just account categories. Money becomes legible as stability, freedom, and responsibility rather than a spreadsheet-only surface.';
  }
  if (/personal/.test(key)) {
    return 'The deeper read is the non-work life system: health, learning, coaching, family, home, hobbies, and the recurring attempt to live with more taste and less drift.\n\nAt 4k, this connects the practical threads to the emotional center of gravity: what gives energy, what asks for care, what has changed recently, and what kind of life the system is helping you protect.';
  }
  if (/writing|user voice/.test(key)) {
    return 'The deeper read is the gap between sounding polished and saying something true. Writing holds drafts, voice calibration, public posts, essays, memos, and the recurring discipline of compressing raw judgment until it lands.\n\nAt 4k, this preserves the live argument, the intended audience, the drift risks, and the owner voice. The next draft gets easier because the thinking is sharper.';
  }
  if (/\bwork\b/.test(key)) {
    return 'The deeper read is the work map underneath the daily task list: active professional commitments, opportunities, judgment calls, and the threads that deserve attention now.\n\nAt 4k, this separates live work from source mechanics. It says what changed, what is over, what remains unresolved, and which commitment should shape the next decision.';
  }
  // Owner-specific institution/network deep briefs ship only in the gitignored
  // lens override; tracked code returns the generic '' below when it is empty.
  const lensDeep = topicLensOverride(key, 'deepBrief');
  if (lensDeep) return lensDeep;
  if (/learning/.test(key)) {
    return 'The deeper read is curiosity becoming capability. Not every interest is equal; some are passing fascination, and some become judgment or skill.\n\nAt 4k, this distinguishes consumption from compounding. It says what you are actively learning, why it matters now, and where the thread is turning into usable understanding.';
  }
  if (/networking/.test(key)) {
    return 'The deeper read is relationship leverage, not contact volume. Networking matters here when it opens a real door: a company, role, founder, investor, operator, or conversation that changes the map.\n\nAt 4k, this distinguishes warm paths from ambient channels. It preserves who actually helps, what was asked, what is owed, and where social capital deserves care.';
  }
  if (/hobbies/.test(key)) {
    return 'The deeper read is the part of life that restores taste and attention without needing to become a project. Hobbies matter because they show what you return to when the work identity loosens its grip.\n\nAt 4k, this preserves the activities, places, and interests that give energy back: what is active, what is dormant, and what belongs in life because it feels good rather than because it compounds.';
  }
  if (/newsletter|\bnl\b|^nl/.test(key)) {
    return 'The deeper read is signal versus subscription noise. Newsletters matter only when they change your map of the world, sharpen a decision, or keep you close to a market you actually act in.\n\nAt 4k, this identifies the recurring sources, the signal they provide, and what can be ignored. It feels like an intelligence filter, not an inbox inventory.';
  }
  return '';
}

function cleanWorkingBriefMarkdown(markdown) {
  const sections = parseMarkdownSections(String(markdown || ''));
  const kept = [];
  for (const section of sections) {
    if (section.level > 0 && /timeline/i.test(section.title)) continue;
    const content = displayProjectionMarkdown(section.content);
    if (!hasMeaningfulMarkdown(content)) continue;
    kept.push(section.level > 0 ? `${'#'.repeat(section.level)} ${section.title}\n\n${content}` : content);
  }
  return kept.join('\n\n')
    .replace(/(?:^|\n)\s*---+\s*(?=\n|$)/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function alternateBriefSections(kind, sections, currentRead = '') {
  const candidates = sections
    .filter((section) =>
      section.level > 0
	      && hasMeaningfulMarkdown(section.content)
	      && !isProjectionNoiseSection(section.title)
	      && !/timeline/i.test(section.title)
      && !isNoisyPlaceArtifactSection(kind, section)
      && !isBriefExcludedEntitySection(kind, section)
      && !(isEntityKind(kind) && /summary/i.test(section.title) && looksLikeImportedDataCard(section.content))
      && !/current read|read on/i.test(section.title))
    .map((section) => ({ section, markdown: `## ${section.title}\n\n${displayProjectionMarkdown(section.content)}` }));
  const briefSections = candidates.filter(({ section, markdown }) =>
    !isCurrentReadTitleSection(section, currentRead)
    && !sameOrPrefixMarkdown(markdown, currentRead));
  const alternate = briefSections
    .map(({ markdown }) => markdown)
    .join('\n\n');
  return sameMarkdownBody(alternate, currentRead) ? '' : alternate;
}

function isCurrentReadTitleSection(section, currentRead) {
  if (section.level !== 1) return false;
  const title = normalizeTitleText(section.title);
  const read = normalizeTitleText(currentRead).slice(0, Math.max(title.length + 24, 80));
  return title.length >= 4 && read.startsWith(title);
}

function isBriefExcludedEntitySection(kind, section) {
  if (!isEntityKind(kind)) return false;
  const title = String(section?.title || '');
  const content = String(section?.content || '').trim();
  if (/relationship timeline|timeline|history/i.test(title)) return true;
  if (/post-call research|research note|external research/i.test(title)) return true;
  if (/search results do not contain|additional sources .* required|no substantive information/i.test(content)) return true;
  if (/key topics/i.test(title) && /^[-\w\s,]+$/.test(content) && content.split(',').length >= 4) return true;
  return false;
}

function normalizeTitleText(value) {
  return String(value || '')
    .replace(/[_*`~#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isNoisyPlaceArtifactSection(kind, section) {
  if (!/^(place|places)$/i.test(String(kind || ''))) return false;
  const title = String(section?.title || '');
  const content = String(section?.content || '');
  return /when you dine at restaurants worldwide|Terms apply|How likely are you to recommend|LEARN MORE As a valued guest/i.test(`${title}\n${content}`)
    || Boolean(capturedPlaceArtifact(title));
}

function sameMarkdownBody(a, b) {
  return normalizeMarkdownBody(a) === normalizeMarkdownBody(b);
}

function sameLooseTitle(a, b) {
  const left = normalizeTitleText(a);
  const right = normalizeTitleText(b);
  return Boolean(left && right && left === right);
}

function sameOrPrefixMarkdown(a, b) {
  const left = normalizeMarkdownBody(a);
  const right = normalizeMarkdownBody(b);
  if (!left || !right) return false;
  return left.startsWith(right.slice(0, Math.min(right.length, 360)))
    || right.startsWith(left.slice(0, Math.min(left.length, 360)));
}

function normalizeMarkdownBody(value) {
  return String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#+\s+.+$/gm, '')
    .replace(/^\s*---+\s*$/gm, '')
    .split(/\r?\n/)
    .filter((line) => !isProjectionNoiseLine(line))
    .map(stripProjectionSourceSuffix)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasMeaningfulMarkdown(value) {
  const normalized = normalizeMarkdownBody(value)
    .replace(/[_*`~]/g, '')
    .trim();
  return normalized
    && !/^no prior history recorded yet\.?$/i.test(normalized)
    && !/^[\w\s&/.-]+ — Executive Summary(?: \(General\))?\.?$/i.test(normalized);
}

function isEntityKind(kind) {
  return /^(person|people|company|companies|place|places)$/i.test(String(kind || ''));
}

function stripLeadingTitle(markdown) {
  return String(markdown || '').replace(/^#\s+.+(?:\r?\n)+/, '').trim();
}

function cleanProjectionMarkdown(markdown) {
  const lines = String(markdown || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/);
  const kept = [];
  let skippingNoiseSection = false;

  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      skippingNoiseSection = isProjectionNoiseSection(heading[2]);
      if (skippingNoiseSection) continue;
    }
    if (skippingNoiseSection) continue;
    if (isProjectionNoiseLine(line)) continue;
    kept.push(line);
  }

  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function displayProjectionMarkdown(markdown) {
  return stripInlineContactArtifacts(String(markdown || '')
    .split(/\r?\n/)
    .filter((line) => !isProjectionNoiseLine(line) && !isRenderedMetadataNoiseLine(line))
    .map(stripProjectionSourceSuffix)
    .join('\n'))
	    .replace(/\s*\(the user\)/gi, '')
	    .replace(/\bthe user's\b/gi, 'your')
	    .replace(/\bthe user has\b/gi, 'you have')
	    .replace(/\bthe user is\b/gi, 'you are')
	    .replace(/\bthe user was\b/gi, 'you were')
	    .replace(/\bthe user\b/gi, 'you')
	    .replace(/\bthis user\b/gi, 'you')
	    .replace(/\bThe relationship with you\b/g, 'Your relationship')
	    .replace(/\bYour relationship with ([^\s]+@[^\s]+) with ([A-Z][a-z]+)\b/g, 'Your relationship with $2')
	    .replace(/\byou\s*\(owner\)\s+has\b/gi, 'you have')
	    .replace(/\byou\s*\(owner\)\b/gi, 'you')
	    .replace(/\bwith you is classified\b/gi, 'is classified')
	    .replace(/\byou ships\b/gi, 'you ship')
	    .replace(/\byou receives\b/gi, 'you receive')
	    .replace(/\byou works\b/gi, 'you work')
	    .replace(/\n{3,}/g, '\n\n')
	    .replace(/^(you|your)\b/, (match) => match.charAt(0).toUpperCase() + match.slice(1))
    .trim();
}

function stripInlineContactArtifacts(value) {
  return String(value || '')
    .replace(/,?\s*\breachable at\s+`?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`?/gi, '')
    .replace(/,?\s*(?:and\s+)?\b(?:his|her|their)?\s*phone number is\s+\+?\d[\d\s().-]{6,}\d(?:\s*\([^)]*\))?/gi, '')
    .replace(/\s*\((?:phone|email):\s*[^)]*\)/gi, '')
    .replace(/\s*\((?:mobile|cell|direct phone|phone number):\s*[^)]*\)/gi, '')
    .replace(/\s*\(`?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`?\)/gi, '')
    .replace(/`[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`/gi, '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '')
    .replace(/(?:\+?\d[\d\s().-]{6,}\d|\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)/g, '')
    .replace(/\s+classified as (?:Core|Network|Family|Professional|Personal|Acquaintance)\b/gi, '')
    .replace(/\s+\(\s*\)/g, '')
    .replace(/[ \t]+([,.;:])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}

function isProjectionNoiseSection(title) {
  return /source watermark|source records|projection metadata/i.test(String(title || ''));
}

function isProjectionNoiseLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;
  return /memory_projection|source_event_|source_set_hash|projection version|source records|source event range/i.test(text)
    || /chat\.message|memory_events/i.test(text)
    || /\bNot relevant:/i.test(text)
    || /Continue from the newest source-backed synthesis/i.test(text)
    || /^[-*]?\s*(?:\*\*)?(?:primary\s+)?sources?:/i.test(text)
    || /^[-*]?\s*(decision\s+)?source:\s/i.test(text)
    || /^\*?[\w\s/&.-]+(?: > [\w\s/&.-]+)? \| Known since [^|]+ \| Last contact [^*]+\*?$/i.test(text)
    || /^\*?[\w\s/&.-]+ \| \d+ visits?\*?$/i.test(text);
}

function isRenderedMetadataNoiseLine(line) {
  return /^[-*]?\s*(?:description|website|funding_stage|total_raised|lead_investors|employee_range|linkedin_url|current_role|twitter):\s/i.test(String(line || '').trim());
}

function projectionSourceSuffix(line) {
  const match = String(line || '').match(/\s+Sources?:\s+(.+?)\.?\s*$/i);
  return match ? match[1].trim() : '';
}

function stripProjectionSourceSuffix(line) {
  const text = String(line || '');
  const source = projectionSourceSuffix(text);
  if (!source) return text;
  return text.slice(0, text.search(/\s+Sources?:\s+/i)).trimEnd();
}

function trimMarkdown(markdown, maxChars) {
  const text = String(markdown || '').trim();
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const cut = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf('\n- '));
  return `${slice.slice(0, cut > maxChars * 0.55 ? cut + 1 : maxChars).trim()}…`;
}

function extractTimelineItems(sections, markdown) {
  const items = [];
  for (const section of sections) {
    if (looksLikeLegacyDataCard(section.content)) continue;
    const headingDate = firstDateText(section.title);
    if (
      headingDate
      && section.content
      && isDatedTimelineHeading(section.title, headingDate)
      && !isTimelineNoiseLine(section.title)
    ) {
      const body = displayProjectionMarkdown(section.content);
      if (isTimelineNoiseLine(body)) continue;
      items.push({
        dateText: headingDate,
        title: section.title.replace(headingDate, '').replace(/[—:-]+$/, '').trim() || section.title,
        body: trimPlain(body, 260),
        sort: timelineSortValue(headingDate),
      });
    }

    if (isTimelineSectionTitle(section.title)) {
      for (const line of section.content.split(/\r?\n/)) {
        const item = timelineItemFromLine(line);
        if (item) items.push(item);
      }
    }
  }

  if (!items.length) {
    const fallbackMarkdown = sections
      .filter((section) => hasMeaningfulMarkdown(section.content) && !looksLikeLegacyDataCard(section.content))
      .map((section) => section.content)
      .join('\n');
    const fallbackSource = fallbackMarkdown || (looksLikeLegacyDataCard(markdown) ? '' : markdown);
    for (const line of String(fallbackSource || '').split(/\r?\n/)) {
      const item = timelineItemFromLine(line);
      if (item) items.push(item);
    }
  }

  return dedupeTimelineItems(items)
    .sort((a, b) => b.sort - a.sort);
}

function timelineEvidenceItems(data) {
  const evidence = data?.evidence;
  if (Array.isArray(evidence)) return evidence;
  if (Array.isArray(evidence?.timeline)) return evidence.timeline;
  if (Array.isArray(data?.timelineEvidence)) return data.timelineEvidence;
  return [];
}

function timelineEvidenceCounts(data) {
  const counts = data?.evidence?.counts || data?.timelineEvidenceCounts || null;
  if (!counts || typeof counts !== 'object') return null;
  return {
    shown: Number(counts.timeline || counts.shown || 0) || 0,
    total: Number(counts.total || 0) || 0,
    truncated: Boolean(counts.truncated),
  };
}

function mergeTimelineEvidence(markdownItems, evidenceItems) {
  const merged = [
    ...markdownItems,
    ...evidenceItems.map(timelineItemFromEvidence).filter(Boolean),
  ];
  return dedupeTimelineItems(merged)
    .sort((a, b) => (b.sort || 0) - (a.sort || 0));
}

function timelineItemFromEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const dateText = evidence.dateText || firstDateText(evidence.eventDate || evidence.event_time || evidence.date || '');
  if (!dateText) return null;
  const title = trimPlain(evidence.title || evidence.summary || evidence.excerpt || '', 160);
  if (!title || isTimelineNoiseLine(title) || isLowValueTimelineBody(title)) return null;
  const body = trimPlain(evidence.body || evidence.content || '', 280);
  const sourceLabel = trimPlain(evidence.sourceLabel || evidence.source || '', 80);
  const role = trimPlain(evidence.role || '', 40);
  const evidenceType = trimPlain(evidence.evidenceType || evidence.type || '', 40);
  const sourceRef = trimPlain(
    evidence.sourceRef
    || evidence.source_ref
    || evidence.evidenceId
    || evidence.evidence_id
    || evidence.eventId
    || evidence.event_id
    || evidence.sourceId
    || evidence.source_id
    || evidence.chunkId
    || evidence.chunk_id
    || '',
    120,
  );
  return {
    dateText,
    title,
    body: sameTimelineText(title, body) || isTimelineNoiseLine(body) ? '' : body,
    sort: Number(evidence.sort) || timelineSortValue(dateText),
    sourceLabel,
    role,
    evidenceType,
    sourceRef,
  };
}

function isTimelineSectionTitle(title) {
  return /history|timeline|chronology|recent signal|live signal|call notes|latest state|next action/i.test(String(title || ''));
}

function isDatedTimelineHeading(title, dateText) {
  const clean = String(title || '').trim();
  return clean.startsWith(dateText);
}

function timelineItemFromLine(line) {
  const source = projectionSourceSuffix(line);
  if (source) return null;
  const cleaned = stripProjectionSourceSuffix(String(line || '').replace(/^[-*]\s+/, '').trim());
  if (isTimelineNoiseLine(cleaned)) return null;
  if (!cleaned || cleaned.length < 16) return null;
  const dateText = firstDateText(cleaned);
  if (!dateText) return null;
  const dateIndex = cleaned.indexOf(dateText);
  if (dateIndex !== 0) return null;
  const body = cleaned.replace(dateText, '').replace(/^[:—-]\s*/, '').trim();
  if (isTimelineNoiseLine(body)) return null;
  if (isLowValueTimelineBody(body)) return null;
  const title = timelineTitle(body);
  const plainBody = trimPlain(body, 260);
  return {
    dateText,
    title,
    body: sameTimelineText(title, plainBody) ? '' : plainBody,
    sort: timelineSortValue(dateText),
  };
}

function isTimelineNoiseLine(line) {
  return /chat\.message|memory_events|workbench\.opened|source_event|source_set_hash|projection version|source records|enriched by hakase|sources?:/i.test(String(line || ''));
}

function isLowValueTimelineBody(body) {
  const text = String(body || '').trim();
  return /^\+?\d[\d\s().-]{6,}$/.test(text)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)
    || /(?:\+\d{10,}|\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)/.test(text)
    || /^Invitation:|^Accepted:|^Updated invitation:/i.test(text);
}

function firstDateText(value) {
  const text = String(value || '');
  const patterns = [
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i,
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b/i,
    /\b\d{4}-\d{2}-\d{2}\b/,
    /\b\d{4}\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return '';
}

function timelineSortValue(dateText) {
  const text = String(dateText || '');
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (iso) return Date.parse(`${iso}T00:00:00Z`) || 0;
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return parsed;
  const year = text.match(/\b\d{4}\b/)?.[0];
  return year ? Date.parse(`${year}-01-01T00:00:00Z`) : 0;
}

function timelineTitle(body) {
  const clean = String(body || '').replace(/\s+/g, ' ').trim();
  const sentenceEnd = clean.search(/[.!?](?:\s|$)/);
  const first = sentenceEnd > 24 ? clean.slice(0, sentenceEnd + 1) : clean.slice(0, 96);
  return first || 'Event';
}

function sameTimelineText(a, b) {
  return String(a || '').replace(/\s+/g, ' ').trim().toLowerCase()
    === String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function trimPlain(value, maxChars) {
  const clean = String(value || '')
    .replace(/^#+\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars).trim()}…` : clean;
}

function dedupeTimelineItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const source = item.sourceRef || item.evidenceId || item.sourceId || '';
    if (source) return true;
    const key = `${item.dateText}|${item.title}|${source}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function timelineHtml(items, model = null) {
  if (!items.length) return '<p class="viewer-muted">No timeline events have been distilled yet.</p>';
  const preview = items.slice(0, TIMELINE_PREVIEW_COUNT);
  const overflow = items.slice(TIMELINE_PREVIEW_COUNT);
  const counts = model?.timelineCounts || null;
  const partial = counts?.truncated && counts.total > items.length;
  return `
    ${partial ? `<p class="viewer-muted">Showing ${viewerEsc(String(items.length))} of ${viewerEsc(String(counts.total))} source-backed timeline events.</p>` : ''}
    ${timelineListHtml(preview, model)}
    ${overflow.length ? `
      <details class="viewer-timeline-all">
        <summary>See everything <span>${overflow.length} more</span></summary>
        ${timelineListHtml(overflow, model, 'viewer-timeline-more')}
      </details>
    ` : ''}
  `;
}

function timelineListHtml(items, model = null, extraClass = '') {
  return `
    <ol class="viewer-timeline ${viewerEsc(extraClass)}">
      ${items.map((item) => timelineListItemHtml(item, model)).join('')}
    </ol>
  `;
}

function timelineListItemHtml(item, model = null) {
  return `
    <li>
      <time>${viewerEsc(item.dateText)}</time>
      <div>
        <div class="viewer-timeline-title-row">
          <h3>${viewerEsc(item.title)}</h3>
          ${model ? correctionLinkHtml(model, 'timeline', 'Timeline event', {
            claimText: timelineCorrectionText(item),
            sourceRef: item.sourceRef || '',
          }) : ''}
        </div>
        ${timelineMetaHtml(item)}
        ${item.body ? `<p>${viewerEsc(item.body)}</p>` : ''}
      </div>
    </li>
  `;
}

function timelineCorrectionText(item) {
  return [item.dateText, item.title, item.body].filter(Boolean).join(' - ');
}

function timelineMetaHtml(item) {
  const label = item.sourceLabel || timelineEvidenceLabel(item);
  return label ? `<div class="viewer-timeline-meta">${viewerEsc(label)}</div>` : '';
}

function timelineEvidenceLabel(item) {
  if (item.evidenceType === 'body_mention') return 'Mentioned in source evidence';
  if (item.evidenceType === 'timeline_event') return item.role ? `${item.role} in timeline event` : 'Timeline event';
  return '';
}

function documentTitle(data, body) {
  const fallback = data.label || data.title || data.name || data.displayName || 'Robot Dojo';
  const documentParts = splitMarkdownDocument(body);
  if (documentParts.frontmatter.display_name) return documentParts.frontmatter.display_name;
  if (!isGenericDocumentTitle(fallback)) return fallback;
  const heading = firstMarkdownHeading(documentParts.markdown);
  return heading || inferredSubjectFromMarkdown(documentParts.markdown) || fallback;
}

function isGenericDocumentTitle(title) {
  return /^(index|context|readme|robot dojo)$/i.test(String(title || '').trim());
}

function firstMarkdownHeading(markdown) {
  const matches = Array.from(String(markdown || '').matchAll(/^#\s+(.+)$/gm));
  for (const match of matches) {
    const title = cleanInferredHeadingTitle(match[1]);
    if (title) return title;
  }
  return '';
}

function cleanInferredHeadingTitle(value) {
  const title = String(value || '')
    .replace(/[#\s]+$/, '')
    .replace(/\s+—\s+(?:Company|Person|Place)\s+Profile$/i, '')
    .trim();
  if (/^(summary|about|history|profile|current role|known for|background|relationship)$/i.test(title)) return '';
  return title;
}

function inferredSubjectFromMarkdown(markdown) {
  const text = String(markdown || '')
    .replace(/^---[\s\S]*?---/, '')
    .replace(/^#+\s+.+$/gm, '')
    .replace(/\*\*[^*]+:\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const match = text.match(/\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){1,4})\s+(?:is|publishes|writes|operates|serves|works|appears)\b/);
  return match ? match[1].trim() : '';
}

function documentMetaItems(data, history, frontmatter = {}) {
  const items = [];
  const entity = data.evidence?.entity || {};
  const counts = data.evidence?.counts || {};
  if (data.url) items.push(['URL', data.url]);
  if (data.sha256) items.push(['SHA', String(data.sha256).slice(0, 12)]);
  if (history.length) items.push(['Versions', String(history.length)]);
  if (Array.isArray(data.corrections) && data.corrections.length) items.push(['Corrections', String(data.corrections.length)]);
  if (counts.timeline) items.push(['Timeline events shown', String(counts.timeline)]);
  if (counts.total && counts.total !== counts.timeline) items.push(['Timeline events total', String(counts.total)]);
  if (entity.firstSeen) items.push(['First seen', formatMetaDate(entity.firstSeen)]);
  if (entity.lastSeen) items.push(['Last seen', formatMetaDate(entity.lastSeen)]);
  if (entity.interactionCount) items.push(['Interactions', String(entity.interactionCount)]);
  if (entity.peopleCount) items.push(['Linked people', String(entity.peopleCount)]);
  if (entity.frequency) items.push(['Frequency', String(entity.frequency)]);
  if (entity.totalVisits) items.push(['Total visits', String(entity.totalVisits)]);
  if (data.entityType) items.push(['Entity', data.entityType]);
  if (data.topicSlug) items.push(['Topic', data.topicSlug]);
  for (const item of frontmatterMetaItems(frontmatter)) items.push(item);
  return items;
}

function splitMarkdownDocument(body) {
  const raw = String(body || '');
  const match = raw.match(/^---[ \t]*(?:\r?\n)([\s\S]*?)(?:\r?\n)---[ \t]*(?:\r?\n|$)/);
  if (!match) return { frontmatterRaw: '', frontmatter: {}, markdown: raw };
  return {
    frontmatterRaw: match[0],
    frontmatter: parseFrontmatter(match[1]),
    markdown: raw.slice(match[0].length),
  };
}

function parseFrontmatter(rawYaml) {
  const out = {};
  for (const line of String(rawYaml || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = stripYamlScalar(match[2]);
  }
  return out;
}

function stripYamlScalar(value) {
  const raw = String(value || '').trim();
  const quoted = raw.match(/^(['"])([\s\S]*)\1$/);
  return quoted ? quoted[2] : raw;
}

function frontmatterMetaItems(frontmatter) {
  const items = [];
  const entityClass = [frontmatter.n1, frontmatter.n2].filter(Boolean).join(' > ');
  if (frontmatter.display_name) items.push(['Name', frontmatter.display_name]);
  if (frontmatter.entity_type) items.push(['Type', frontmatter.entity_type]);
  if (entityClass) items.push(['Class', entityClass]);
  if (frontmatter.generated_at) items.push(['Generated', formatMetaDate(frontmatter.generated_at)]);
  if (frontmatter.enrichment) items.push(['Enrichment', frontmatter.enrichment]);
  if (frontmatter.entity_id) items.push(['Entity ID', frontmatter.entity_id]);
  return items;
}

function markdownHtml(body) {
  const C = window.RobotDojoComponents;
  if (C?.markdownHtml) return C.markdownHtml(body);
  if (window.renderProseMarkdown) return window.renderProseMarkdown(body);
  if (window.marked) {
    const html = window.marked.parse(String(body || ''), { breaks: false, gfm: true });
    return window.DOMPurify
      ? window.DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed'],
        FORBID_ATTR: ['style'],
      })
      : html;
  }
  return simpleMarkdownHtml(body);
}

function simpleMarkdownInline(value) {
  return String(value || '')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function simpleMarkdownHtml(body) {
  const escaped = viewerEsc(body);
  return escaped
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split(/\n/).filter((line) => line.trim());
      if (!lines.length) return '';
      const heading = lines.length === 1 ? lines[0].trim().match(/^(#{1,4})\s+(.+)$/) : null;
      if (heading) {
        const level = Math.min(4, heading[1].length + 1);
        return `<h${level}>${simpleMarkdownInline(heading[2])}</h${level}>`;
      }
      if (lines.every((line) => /^[-*]\s+/.test(line.trim()))) {
        const items = lines
          .map((line) => `<li>${simpleMarkdownInline(line.trim().replace(/^[-*]\s+/, ''))}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${simpleMarkdownInline(lines.join('<br>'))}</p>`;
    })
    .join('');
}

function iconButton(iconName, label, id, disabled = false) {
  return `<button type="button" id="${viewerEsc(id)}" class="viewer-btn" title="${viewerEsc(label)}" aria-label="${viewerEsc(label)}" ${disabled ? 'disabled' : ''}>
    <span class="material-symbols-outlined">${viewerEsc(iconName)}</span>
  </button>`;
}

async function copyViewerLink() {
  try {
    await navigator.clipboard.writeText(window.location.href);
    setStatus('Link copied');
  } catch {
    setStatus('Copy failed', 'error');
  }
}

function loadingHtml() {
  const C = window.RobotDojoComponents;
  return C ? C.loadingState('Loading document...') : '<p class="rd-no-content">Loading...</p>';
}

function setStatus(text, tone = 'neutral') {
  const status = document.getElementById('viewerStatus');
  if (!status) return;
  status.textContent = text || '';
  status.dataset.tone = tone;
}

function formatMetaDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatFileSize(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function viewerEsc(value) {
  if (window.esc) return window.esc(value);
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function markViewerReady() {
  if (window.RobotDojoComponents?.setAppReady) {
    window.RobotDojoComponents.setAppReady();
  } else {
    document.body.classList.add('app-ready');
  }
}

window.RobotDojoViewerInternals = {
  resolveViewerRoute,
  buildViewerPageModel,
  projectionModelFromPayload,
  splitMarkdownDocument,
  parseMarkdownSections,
  extractTimelineItems,
  cleanProjectionMarkdown,
  projectCurrentRead,
  selectCurrentReadMarkdown,
  selectWorkingBriefMarkdown,
  cleanPlaceDisplayName,
  capturedPlaceArtifact,
  displayTitleForKind,
  documentKind,
  projectionHtml,
  metadataHtml,
  correctionHref,
  correctionPayload,
  timelineHtml,
};
})();
