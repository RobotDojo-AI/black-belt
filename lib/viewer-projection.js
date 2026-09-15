import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VIEWER_APP_PATH = resolve(__dirname, '..', 'apps', 'viewer', 'app.js');
const VIEWER_PROJECTION_VERSION = 'server-viewer-projection-v10';

let internals = null;
let loadError = null;

function createViewerContext() {
  const classList = { add() {}, contains() { return false; } };
  const window = {
    location: {
      pathname: '/',
      origin: 'http://viewer.local',
      href: 'http://viewer.local/',
    },
    RobotDojoComponents: {
      markdownHtml: (text) => String(text || ''),
      loadingState: (text) => `<p>${text}</p>`,
      setAppReady() {},
    },
    esc: (value) => String(value ?? ''),
  };
  const document = {
    addEventListener() {},
    body: { classList },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    title: '',
  };
  const context = {
    window,
    document,
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    URLSearchParams,
    Date,
    console,
    setTimeout,
    clearTimeout,
    btoa(value) {
      return Buffer.from(String(value), 'binary').toString('base64');
    },
  };
  context.globalThis = context;
  return context;
}

function loadInternals() {
  if (internals || loadError) return internals;
  try {
    const source = readFileSync(VIEWER_APP_PATH, 'utf8');
    const context = createViewerContext();
    vm.createContext(context);
    vm.runInContext(source, context, {
      filename: VIEWER_APP_PATH,
      timeout: 1000,
    });
    internals = context.window.RobotDojoViewerInternals || null;
    if (!internals?.buildViewerPageModel) {
      throw new Error('viewer internals missing buildViewerPageModel');
    }
  } catch (error) {
    loadError = error;
    console.warn('[viewer-projection] disabled:', error?.message || String(error));
    internals = null;
  }
  return internals;
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function redactContactArtifacts(value) {
  return String(value || '')
    .replace(/\bhttps?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/,?\s*\breachable at\s+`?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`?/gi, '')
    .replace(/,?\s*(?:and\s+)?\b(?:his|her|their)?\s*phone number is\s+\+?\d[\d\s().-]{6,}\d(?:\s*\([^)]*\))?/gi, '')
    .replace(/\bJoin by phone\b[^.\n]*/gi, '')
    .replace(/\bMore phone numbers\b[^.\n]*/gi, '')
    .replace(/\b(?:Meeting ID|Passcode|PIN)\s*[:=]?\s*[A-Z0-9 -]{4,}\b/gi, '')
    .replace(/\s*\((?:phone|email|mobile|cell|direct phone|phone number):\s*[^)]*\)/gi, '')
    .replace(/\s*\(`?[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`?\)/gi, '')
    .replace(/`[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}`/gi, '')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '')
    .replace(/\+\d[\d\s().-]{8,}\d/g, '')
    .replace(/\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '')
    .replace(/\b\d{10,}\b/g, '')
    .replace(/[ \t]+([,.;:])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*\./g, '.')
    .replace(/\s+\./g, '.')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanString(value, max = 8000) {
  const text = redactContactArtifacts(value);
  return text.length > max ? text.slice(0, max).trim() : text;
}

function cleanTimelineItem(item = {}) {
  return {
    dateText: cleanString(item.dateText, 32),
    title: cleanString(item.title, 240),
    body: cleanString(item.body, 1200),
    sourceLabel: cleanString(item.sourceLabel, 160),
    sourceRef: cleanString(item.sourceRef, 220),
    phase: cleanString(item.phase || item.evidenceType || '', 80),
  };
}

function fallbackTimelineItems(data = {}) {
  const history = Array.isArray(data.history) ? data.history : [];
  if (history.length) {
    return history.slice(0, 20).map((item) => cleanTimelineItem({
      dateText: item.createdAt || 'unknown time',
      title: 'Document version captured.',
      body: item.sha256 ? `Prior version ${String(item.sha256).slice(0, 12)} was preserved in document history.` : 'Prior version was preserved in document history.',
      sourceLabel: 'Document history',
      sourceRef: item.file || '',
    }));
  }
  return [cleanTimelineItem({
    dateText: data.generatedAt || data.frontmatter?.generated_at || 'unknown time',
    title: 'Canonical markdown projection loaded.',
    body: 'This page is backed by a canonical markdown source. No richer timeline has been distilled yet.',
    sourceLabel: 'Canonical document',
    sourceRef: data.url || data.relPath || '',
  })];
}

function projectionSourceFingerprint(data = {}, body = '') {
  return stableHash({
    bodySha256: data.sha256 || stableHash({ body }),
    relPath: data.relPath || '',
    url: data.url || '',
    kind: data.kind || '',
    entityType: data.entityType || '',
    topicSlug: data.topicSlug || '',
    workbenchId: data.workbenchId || data.workbench?.id || '',
    evidenceTimeline: (data.evidence?.timeline || []).map((item) => [
      item.id,
      item.dateText,
      item.title,
      item.sourceRef || item.sourceId,
    ]),
    corrections: (data.corrections || []).map((item) => [
      item.event_id || item.id,
      item.recorded_at,
      item.valid_at,
      item.summary || item.correction_text,
    ]),
    workbenchCanonical: (data.workbench?.canonical || []).map((item) => [
      item.name,
      item.updatedAt,
      item.bytes,
      item.exists,
    ]),
  }).slice(0, 24);
}

function normalizeComparable(value) {
  return cleanString(value, 12000)
    .toLowerCase()
    .replace(/[`*_#[\]()>-]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function briefNeedsEvidenceExpansion(brief, currentRead, data = {}, timeline = []) {
  if (data.kind !== 'entity') return false;
  if (!Array.isArray(timeline) || timeline.length < 4) return false;
  const left = normalizeComparable(brief);
  const right = normalizeComparable(currentRead);
  if (!left) return true;
  if (!right) return left.length < 1400;
  if (left === right) return true;
  if (left.startsWith(right) && left.length < right.length + 900) return true;
  if (right.startsWith(left) && right.length < left.length + 900) return true;
  if (left.length < Math.max(1400, right.length * 1.45)) return true;
  return false;
}

function entityKindName(kind, data = {}) {
  const raw = String(data.evidence?.entity?.type || data.entityType || kind || '').toLowerCase();
  if (raw === 'people') return 'person';
  if (raw === 'companies') return 'company';
  if (raw === 'places') return 'place';
  return raw || 'entity';
}

function itemYear(item) {
  return String(item?.dateText || '').match(/\b\d{4}\b/)?.[0] || '';
}

function timelineRange(timeline = []) {
  const dated = timeline.filter((item) => item?.dateText);
  if (!dated.length) return { first: '', last: '' };
  const ascending = [...dated].sort((a, b) => {
    const left = Number(a.sort) || Date.parse(`${a.dateText}T00:00:00Z`) || 0;
    const right = Number(b.sort) || Date.parse(`${b.dateText}T00:00:00Z`) || 0;
    return left - right;
  });
  return {
    first: ascending[0]?.dateText || '',
    last: ascending.at(-1)?.dateText || '',
  };
}

function timelineYearCounts(timeline = []) {
  const counts = new Map();
  for (const item of timeline) {
    const year = itemYear(item);
    if (!year) continue;
    counts.set(year, (counts.get(year) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => b.count - a.count || b.year.localeCompare(a.year));
}

function sourceCounts(timeline = []) {
  const counts = new Map();
  for (const item of timeline) {
    const label = cleanString(item.sourceLabel || '', 80);
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function compactList(items, formatter, limit = 4) {
  return items.slice(0, limit).map(formatter).filter(Boolean).join('; ');
}

function timelineEventPhrase(item) {
  const date = cleanString(item?.dateText || '', 32);
  const title = cleanString(item?.title || '', 150);
  if (!date || !title) return '';
  return `${date}: ${title}`;
}

function currentReadThesis(currentRead) {
  const text = cleanString(currentRead, 800)
    .replace(/^#+\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = text.match(/^.{80,320}?[.!?](?:\s|$)/)?.[0]?.trim();
  return sentence || (text.length > 260 ? `${text.slice(0, 260).trim()}.` : text);
}

function entityMetricSentence(entity = {}, counts = {}, timeline = []) {
  const pieces = [];
  const totalTimeline = Number(counts.total || counts.timeline || timeline.length || 0) || 0;
  if (totalTimeline) pieces.push(`${totalTimeline} source-backed timeline event${totalTimeline === 1 ? '' : 's'}`);
  if (entity.interactionCount) pieces.push(`${entity.interactionCount} recorded interaction${entity.interactionCount === 1 ? '' : 's'}`);
  if (entity.peopleCount) pieces.push(`${entity.peopleCount} linked people`);
  if (entity.frequency) pieces.push(`${entity.frequency} recorded visit${entity.frequency === 1 ? '' : 's'}`);
  if (entity.totalVisits && entity.totalVisits !== entity.frequency) pieces.push(`${entity.totalVisits} total visit${entity.totalVisits === 1 ? '' : 's'}`);
  return pieces.join(' and ');
}

function buildEvidenceWorkingBrief(data = {}, currentRead = '', timeline = [], model = {}) {
  const entity = data.evidence?.entity || {};
  const title = cleanString(model.title || entity.displayName || data.title || 'This entity', 120);
  const kind = entityKindName(model.kind, data);
  const counts = data.evidence?.counts || model.timelineCounts || {};
  const range = timelineRange(timeline);
  const yearCounts = timelineYearCounts(timeline);
  const sources = sourceCounts(timeline);
  const newest = timeline.slice(0, 5);
  const oldest = [...timeline].slice(-5).reverse();
  const metrics = entityMetricSentence(entity, counts, timeline);
  const thesis = currentReadThesis(currentRead);
  const denseYears = compactList(yearCounts, (item) => `${item.year} (${item.count})`, 6);
  const sourceSummary = compactList(sources, (item) => `${item.label} (${item.count})`, 4);
  const firstLast = [range.first, range.last].filter(Boolean).join(' to ');

  const paragraphs = [];
  paragraphs.push(`${title} is a ${kind} whose useful context is the evidence map behind the 1k read. ${thesis ? `The active thesis is: ${thesis}` : 'The active thesis should come from the 1k card, then be checked against the timeline before answering.'}`);

  const substrate = [
    firstLast ? `The structured trail runs ${firstLast}` : '',
    metrics ? `with ${metrics}` : '',
  ].filter(Boolean).join(', ');
  if (substrate) {
    paragraphs.push(`${substrate}. This means the long brief should not behave like a bio card or static database card; it should orient the model to relationship history, recency, density, and the source trail.`);
  }

  if (denseYears) {
    paragraphs.push(`The densest years in the visible audit trail are ${denseYears}. Use those years as jump points: dense years usually hold the relationship texture, while sparse years are better for origin, status changes, or isolated facts.`);
  }

  if (newest.length) {
    paragraphs.push(`Newest source-backed signals: ${compactList(newest, timelineEventPhrase, 5)}.`);
  }

  if (oldest.length) {
    paragraphs.push(`Origin signals still need to stay in frame: ${compactList(oldest, timelineEventPhrase, 5)}.`);
  }

  if (sourceSummary) {
    paragraphs.push(`Source mix: ${sourceSummary}. The timeline is the audit trail. RAG is the detail layer for exact wording, surrounding messages, attachments, and source context.`);
  } else {
    paragraphs.push('The timeline is the audit trail. RAG is the detail layer for exact wording, surrounding messages, attachments, and source context.');
  }

  paragraphs.push(`For chat or work injection, start with the 1k thesis, carry this date range and density map, then choose the next lookup by query intent: newest events for current status, origin events for relationship background, dense years for pattern questions, and RAG when the answer needs verbatim context. Corrections must come from typed correction events and regenerate this projection; ordinary chat should not silently rewrite the source story.`);

  return paragraphs.join('\n\n');
}

export function buildViewerProjection(data = {}, body = '') {
  const api = loadInternals();
  if (!api) return null;
  const projectionInput = { ...data };
  delete projectionInput.projection;
  const model = api.buildViewerPageModel(projectionInput, body || data.body || '');
  const timeline = Array.isArray(model.timeline) ? model.timeline.map(cleanTimelineItem).filter((item) => item.dateText && item.title) : [];
  const currentRead = cleanString(model.currentRead, 1200);
  const rawWorkingBrief = cleanString(model.workingBrief, 4800);
  const workingBrief = briefNeedsEvidenceExpansion(rawWorkingBrief, currentRead, data, timeline)
    ? cleanString(buildEvidenceWorkingBrief(data, currentRead, timeline.length ? timeline : fallbackTimelineItems(data), model), 4800)
    : rawWorkingBrief;
  return {
    version: VIEWER_PROJECTION_VERSION,
    sourceFingerprint: projectionSourceFingerprint(data, body || data.body || ''),
    title: cleanString(model.title, 300),
    kind: cleanString(model.kind, 80),
    targetType: cleanString(model.targetType, 80),
    targetId: cleanString(model.targetId, 220),
    url: cleanString(model.url || data.url || '', 500),
    frontmatter: model.frontmatter && typeof model.frontmatter === 'object' ? model.frontmatter : {},
    workbench: model.workbench || null,
    corrections: Array.isArray(model.corrections) ? model.corrections : [],
    currentRead,
    workingBrief,
    timeline: timeline.length ? timeline : fallbackTimelineItems(data),
    timelineCounts: model.timelineCounts || {},
    thinMeta: Array.isArray(model.thinMeta) ? model.thinMeta.map((item) => cleanString(item, 160)).filter(Boolean).slice(0, 4) : [],
    navItems: [
      ['current-read', '1k summary'],
      ['working-brief', '4k summary'],
      ['timeline', 'Timeline'],
      ['metadata', 'Metadata'],
    ],
    generatedAt: new Date().toISOString(),
  };
}

export { VIEWER_PROJECTION_VERSION };
