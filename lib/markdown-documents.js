import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  AGENTS_REL_ROOT,
  REPO_ROOT,
  USER_CONTEXTS_REL,
  USER_WORKBENCHES_REL,
  WK_USER_CONTEXT_PATH,
  WK_USER_DEEP_PATH,
} from './robotdojo-paths.js';
import { entityDir, entityPackageName, entityShortId, topicContextPath } from './context-paths.js';
import { getTopicBySlug } from './content-queries.js';
import { lookupWorkbenchRoute, topicUrlFromWorkbenchRoot, workbenchPublicUrl } from './workbenches.js';
import { buildWorkbenchLibrary } from './workbench-library.js';
import { updateTopicContext } from './topics.js';
import { listViewerCorrections } from './viewer-corrections.js';
import { buildViewerProjection, VIEWER_PROJECTION_VERSION } from './viewer-projection.js';
import { entityEvidenceForDocument } from './entity-evidence.js';
import config from './config.js';

const TYPE_ALIASES = new Map([
  ['person', 'people'],
  ['people', 'people'],
  ['company', 'companies'],
  ['companies', 'companies'],
  ['place', 'places'],
  ['places', 'places'],
]);

const ALLOWED_DIRECT_PREFIXES = [
  `${AGENTS_REL_ROOT}/`,
  `${USER_CONTEXTS_REL}/`,
  `${USER_WORKBENCHES_REL}/`,
];

const WORKBENCH_CANONICAL_FILES = [
  'INDEX.md',
  'SYNTHESIS.md',
  'LOG.md',
  'SESSION-STATUS.md',
  'REPORTS.md',
];

const DOCUMENT_PAYLOAD_CACHE_MS = Number(process.env.ROBOTDOJO_VIEWER_DOCUMENT_CACHE_MS || 60_000);
const DOCUMENT_PAYLOAD_CACHE_MAX = Number(process.env.ROBOTDOJO_VIEWER_DOCUMENT_CACHE_MAX || 256);
const DOCUMENT_PAYLOAD_DISK_CACHE_MS = Number(process.env.ROBOTDOJO_VIEWER_DOCUMENT_DISK_CACHE_MS || 86_400_000);
const DOCUMENT_PAYLOAD_DISK_CACHE_DIR = join(config.configDir, 'cache', 'viewer-documents');
const VIEWER_ENTITY_TIMELINE_LIMIT = Math.max(16, Math.min(2000, Number(process.env.ROBOTDOJO_VIEWER_ENTITY_TIMELINE_LIMIT || 1000)));
const documentPayloadCache = new Map();
let viewerCorrectionsRevision = 0;

function sha256Hex(content) {
  return createHash('sha256').update(content || '').digest('hex');
}

function clonePayload(value) {
  return JSON.parse(JSON.stringify(value));
}

function cacheEnabled() {
  return process.env.NODE_ENV !== 'test'
    && DOCUMENT_PAYLOAD_CACHE_MS > 0
    && DOCUMENT_PAYLOAD_CACHE_MAX > 0;
}

function diskCacheEnabled() {
  return DOCUMENT_PAYLOAD_DISK_CACHE_MS > 0;
}

function correctionWatermark(db) {
  try {
    const row = db?.prepare?.(`
      SELECT COUNT(*) AS count, MAX(recorded_at) AS recordedAt, MAX(event_id) AS lastId
      FROM memory_events
      WHERE event_type = 'viewer.correction.recorded'
    `)?.get?.();
    return `${row?.count || 0}:${row?.recordedAt || ''}:${row?.lastId || ''}`;
  } catch {
    return '';
  }
}

function documentCacheKey(doc, stat, bodySha, correctionsWatermark = '') {
  return [
    VIEWER_PROJECTION_VERSION,
    doc.relPath,
    stat?.mtimeMs || 0,
    stat?.size || 0,
    bodySha || 'null',
    correctionsWatermark,
  ].join('|');
}

function getCachedPayload(key) {
  if (!cacheEnabled() || !key) return null;
  const cached = documentPayloadCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    if (cached) documentPayloadCache.delete(key);
    return null;
  }
  documentPayloadCache.delete(key);
  documentPayloadCache.set(key, cached);
  return clonePayload(cached.payload);
}

function diskCachePath(key) {
  return join(DOCUMENT_PAYLOAD_DISK_CACHE_DIR, `${sha256Hex(key).slice(0, 32)}.json`);
}

function getDiskCachedPayload(key) {
  if (!diskCacheEnabled() || !key) return null;
  const path = diskCachePath(key);
  try {
    if (!existsSync(path)) return null;
    const stat = statSync(path);
    if (stat.mtimeMs + DOCUMENT_PAYLOAD_DISK_CACHE_MS <= Date.now()) return null;
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    if (cached?.cacheKey !== key || !cached?.payload) return null;
    return clonePayload(cached.payload);
  } catch {
    return null;
  }
}

function setDiskCachedPayload(key, payload) {
  if (!diskCacheEnabled() || !key || !payload) return;
  try {
    mkdirSync(DOCUMENT_PAYLOAD_DISK_CACHE_DIR, { recursive: true });
    writeFileSync(diskCachePath(key), JSON.stringify({ cacheKey: key, payload }) + '\n', 'utf8');
  } catch {
    // Disk cache is a performance aid; memory/request behavior remains authoritative.
  }
}

function setCachedPayload(key, payload) {
  if (!cacheEnabled() || !key) return;
  documentPayloadCache.set(key, {
    expiresAt: Date.now() + DOCUMENT_PAYLOAD_CACHE_MS,
    payload: clonePayload(payload),
  });
  while (documentPayloadCache.size > DOCUMENT_PAYLOAD_CACHE_MAX) {
    const oldest = documentPayloadCache.keys().next().value;
    documentPayloadCache.delete(oldest);
  }
}

export function invalidateMarkdownDocumentCache() {
  documentPayloadCache.clear();
}

export function markViewerCorrectionsChanged() {
  viewerCorrectionsRevision += 1;
  invalidateMarkdownDocumentCache();
}

function normalizeRoutePath(routePath) {
  const raw = String(routePath || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!raw) return '';
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    const error = new Error('invalid_path');
    error.status = 400;
    throw error;
  }
  return parts.join('/');
}

function withoutMd(value) {
  return String(value || '').replace(/\.md$/i, '');
}

function ensureMd(relPath) {
  return /\.md$/i.test(relPath) ? relPath : `${relPath}.md`;
}

function toRepoRel(absPath) {
  return relative(REPO_ROOT, absPath).replace(/\\/g, '/');
}

function toAbs(relPath) {
  return resolve(REPO_ROOT, relPath);
}

function cleanTitle(value) {
  return String(value || 'Document')
    .replace(/\.md$/i, '')
    .replace(/--[0-9a-f]{8,}$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || 'Document';
}

function findCaseInsensitivePath(relPath) {
  const parts = relPath.split('/').filter(Boolean);
  let currentAbs = REPO_ROOT;
  const resolved = [];
  for (const part of parts) {
    let entries = [];
    try { entries = readdirSync(currentAbs, { withFileTypes: true }); } catch { return null; }
    const match = entries.find((entry) => entry.name === part)
      || entries.find((entry) => entry.name.toLowerCase() === part.toLowerCase());
    if (!match) return null;
    resolved.push(match.name);
    currentAbs = join(currentAbs, match.name);
  }
  return resolved.join('/');
}

function resolveDirectMarkdown(relPath) {
  const candidates = [ensureMd(relPath)];
  if (!/\/SKILL$/i.test(relPath) && !/\/skill\.md$/i.test(relPath)) {
    candidates.push(relPath.replace(/\/skill$/i, '/SKILL.md'));
  }
  for (const candidate of candidates) {
    const preferExactPath = /^user\/contexts\/(?:people|companies|places)\//i.test(candidate);
    if (preferExactPath && existsSync(toAbs(candidate))) return candidate;
    const insensitive = findCaseInsensitivePath(candidate);
    if (insensitive && existsSync(toAbs(insensitive))) return insensitive;
    if (existsSync(toAbs(candidate))) return candidate;
  }
  return candidates[0];
}

function routeForRelPath(relPath) {
  const noMd = withoutMd(relPath);
  const persona = noMd.match(/^agents\/personas\/([^/]+)$/);
  if (persona) return `/agents/${persona[1].toLowerCase()}`;
  if (relPath === toRepoRel(WK_USER_CONTEXT_PATH)) return '/user/context';
  if (relPath === toRepoRel(WK_USER_DEEP_PATH)) return '/user/profile';

  const entity = noMd.match(/^user\/contexts\/(people|companies|places)\/([^/]+)(?:\/(.+))?$/);
  if (entity) {
    const [, type, pkg, doc = 'context'] = entity;
    return doc === 'context' ? `/${type}/${pkg}` : `/${type}/${pkg}/${doc}`;
  }

  const topic = noMd.match(/^user\/contexts\/topics\/(.+)\/context$/);
  if (topic) {
    const topicParts = topic[1].split('/').filter(Boolean);
    if (topicParts.length >= 2) return `/${topicParts[0]}/${topicParts[1]}`;
    if (topicParts.length === 1) return `/${topicParts[0]}`;
  }

  if (noMd.startsWith(`${USER_WORKBENCHES_REL}/`)) {
    const stripIndex = (rest) => String(rest || '').replace(/\/INDEX$/i, '').replace(/^INDEX$/i, '');
    const nested = noMd.match(new RegExp(`^${USER_WORKBENCHES_REL}/topics/([^/]+)/([^/]+)/wk_[^/]+(?:/(.+))?$`, 'i'));
    if (nested && !/^wk[_-]/i.test(nested[2])) {
      const rest = stripIndex(nested[3]);
      return rest ? `/${nested[1]}/${nested[2]}/${rest}` : `/${nested[1]}/${nested[2]}`;
    }
    const top = noMd.match(new RegExp(`^${USER_WORKBENCHES_REL}/topics/([^/]+)/wk_[^/]+(?:/(.+))?$`, 'i'));
    if (top && !/^wk[_-]/i.test(top[1])) {
      const rest = stripIndex(top[2]);
      return rest ? `/${top[1]}/${rest}` : `/${top[1]}`;
    }
    const fromRoot = topicUrlFromWorkbenchRoot(`${noMd}/`);
    if (fromRoot) {
      const rest = stripIndex(noMd.replace(/^.*\/wk_[^/]+/i, '').replace(/^\//, ''));
      return rest ? `${fromRoot}/${rest}` : fromRoot;
    }
    const rest = noMd.slice(USER_WORKBENCHES_REL.length + 1).replace(/\/INDEX$/i, '');
    return `/workbenches/${rest}`;
  }

  return `/docs/${noMd}`;
}

function resolveAgentDocument(rest) {
  if (!rest) return { kind: 'agent', relPath: 'agents/agents.md', title: 'Agents' };
  if (!rest.includes('/')) {
    const personaRel = resolveDirectMarkdown(`agents/personas/${rest}`);
    if (existsSync(toAbs(personaRel))) {
      return { kind: 'agent', relPath: personaRel, title: cleanTitle(basename(personaRel)) };
    }
  }
  const relPath = resolveDirectMarkdown(`agents/${rest}`);
  return { kind: 'agent', relPath, title: cleanTitle(basename(relPath)) };
}

function resolveUserDocument(rest) {
  if (!rest || rest === 'context') {
    return { kind: 'user', relPath: toRepoRel(WK_USER_CONTEXT_PATH), title: 'User Context' };
  }
  if (['profile', 'deep', 'user'].includes(rest)) {
    return { kind: 'user', relPath: toRepoRel(WK_USER_DEEP_PATH), title: 'User Profile' };
  }
  const relPath = rest.startsWith('workbenches/') || rest.startsWith('contexts/')
    ? resolveDirectMarkdown(`user/${rest}`)
    : resolveDirectMarkdown(`${USER_WORKBENCHES_REL}/user/wk_user/${rest}`);
  return { kind: 'user', relPath, title: cleanTitle(basename(relPath)) };
}

function findTopicContextRelBySlug(slug) {
  const topicSlug = normalizeRoutePath(slug);
  if (!topicSlug) return null;
  const exactRel = `${USER_CONTEXTS_REL}/topics/${topicSlug}/context.md`;
  if (existsSync(toAbs(exactRel))) return exactRel;

  const topicsRootRel = `${USER_CONTEXTS_REL}/topics`;
  const topicsRootAbs = toAbs(topicsRootRel);
  const stack = [{ abs: topicsRootAbs, rel: topicsRootRel, depth: 0 }];
  const target = topicSlug.toLowerCase();
  let visited = 0;
  while (stack.length && visited < 2000) {
    const current = stack.pop();
    visited += 1;
    let entries = [];
    try { entries = readdirSync(current.abs, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const rel = `${current.rel}/${entry.name}`;
      const abs = join(current.abs, entry.name);
      if (entry.name.toLowerCase() === target) {
        const contextRel = `${rel}/context.md`;
        if (existsSync(toAbs(contextRel))) return contextRel;
      }
      if (current.depth < 4) stack.push({ abs, rel, depth: current.depth + 1 });
    }
  }
  return null;
}

function resolveTopicDocument(db, slug) {
  const topicSlug = normalizeRoutePath(slug);
  const fileRelPath = findTopicContextRelBySlug(topicSlug);
  if (fileRelPath) {
    return {
      kind: 'topic',
      relPath: fileRelPath,
      title: cleanTitle(topicSlug),
      topicSlug,
    };
  }
  const topic = getTopicBySlug(db, topicSlug);
  if (!topic) {
    const error = new Error('not_found');
    error.status = 404;
    throw error;
  }
  return {
    kind: 'topic',
    relPath: topicContextPath(db, topicSlug),
    title: topic.label || cleanTitle(topicSlug),
    topicSlug,
  };
}

function resolveEntityDocument(rest, db) {
  const parts = normalizeRoutePath(rest).split('/').filter(Boolean);
  const type = TYPE_ALIASES.get(parts[0]);
  let packageName = parts[1];
  if (!type || !packageName) {
    const error = new Error('not_found');
    error.status = 404;
    throw error;
  }
  const singular = type === 'people' ? 'person' : type === 'companies' ? 'company' : 'place';
  const docPath = parts.slice(2).join('/') || 'context';
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(packageName);
  if (uuidLike && db) {
    const packed = entityPackageName(singular, packageName, db);
    const packedRel = `${USER_CONTEXTS_REL}/${entityDir(singular)}/${packed}/${docPath}`;
    if (existsSync(toAbs(packedRel)) || existsSync(toAbs(resolveDirectMarkdown(packedRel)))) {
      packageName = packed;
    } else {
      const short = entityShortId(packageName);
      const matchRel = findEntityPackageByShortId(singular, short, docPath);
      if (matchRel) packageName = matchRel;
    }
  }
  const relPath = resolveDirectMarkdown(`${USER_CONTEXTS_REL}/${entityDir(singular)}/${packageName}/${docPath}`);
  return { kind: 'entity', entityType: type, relPath, title: cleanTitle(packageName) };
}

function findEntityPackageByShortId(singular, shortId, docPath) {
  const dirRel = `${USER_CONTEXTS_REL}/${entityDir(singular)}`;
  const dirAbs = toAbs(dirRel);
  let entries = [];
  try { entries = readdirSync(dirAbs, { withFileTypes: true }); } catch { return null; }
  const suffix = `--${shortId}`;
  const hit = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(suffix));
  if (!hit) return null;
  const rel = `${dirRel}/${hit.name}/${docPath}`;
  return existsSync(toAbs(rel)) || existsSync(toAbs(resolveDirectMarkdown(rel))) ? hit.name : null;
}

function resolveWorkbenchDocument(db, rest) {
  const normalized = normalizeRoutePath(rest);
  if (!normalized) {
    const error = new Error('not_found');
    error.status = 404;
    throw error;
  }
  const baseRel = `${USER_WORKBENCHES_REL}/${normalized}`;
  const indexRel = `${baseRel}/INDEX.md`;
  if (existsSync(toAbs(indexRel))) {
    return { kind: 'workbench', relPath: indexRel, title: cleanTitle(basename(indexRel)), workbenchId: workbenchIdFromRelPath(indexRel) };
  }
  const directRel = resolveDirectMarkdown(baseRel);
  if (existsSync(toAbs(directRel))) {
    return { kind: 'workbench', relPath: directRel, title: cleanTitle(basename(directRel)), workbenchId: workbenchIdFromRelPath(directRel) };
  }
  const [key, ...tail] = normalized.split('/').filter(Boolean);
  const wb = lookupWorkbenchRoute(db, key);
  if (wb?.root_path) {
    const rootRel = String(wb.root_path).replace(/\\/g, '/').replace(/^\/+/, '');
    const suffix = tail.join('/');
    const candidate = suffix ? resolveDirectMarkdown(`${rootRel}/${suffix}`) : `${rootRel}/INDEX.md`;
    const relPath = existsSync(toAbs(candidate)) ? candidate : resolveDirectMarkdown(rootRel);
    return {
      kind: 'workbench',
      relPath,
      title: cleanTitle(wb.title || wb.slug || basename(relPath)),
      workbenchId: wb.id,
    };
  }
  const error = new Error('not_found');
  error.status = 404;
  throw error;
}

export const RESERVED_URL_ROOTS = new Set([
  'agents', 'user', 'topics', 'entities', 'people', 'companies', 'places',
  'workbenches', 'workbench', 'chat', 'health', 'network', 'account', 'accounts',
  'podcast', 'docs', 'connect', 'login', 'ask', 'faq', 'privacy', 'terms',
  'licensing', 'install', 'static', 'apps', 'api', 'auth', 'viewer',
  'transcripts', 'subscription', 'pulse', 'setup', 'me', 'version',
]);

function resolveTopicUrlPath(db, normalized) {
  const parts = String(normalized || '').split('/').filter(Boolean);
  if (!parts.length || RESERVED_URL_ROOTS.has(parts[0])) return null;
  const t1 = parts[0];
  const t2 = parts[1] || '';
  const t1row = getTopicBySlug(db, t1);
  if (!t1row) return null;
  if (!t2) return resolveTopicDocument(db, t1);
  const t2row = getTopicBySlug(db, t2);
  const nestedExists = existsSync(toAbs(`${USER_CONTEXTS_REL}/topics/${t1}/${t2}/context.md`));
  const isChild = Boolean((t2row && t2row.parent_slug === t1) || nestedExists);
  if (isChild) {
    const rest = parts.slice(2).join('/');
    if (!rest) return resolveTopicDocument(db, t2);
    const wb = lookupWorkbenchRoute(db, t2);
    if (wb?.root_path) return resolveWorkbenchDocument(db, `${wb.id}/${rest}`);
    return resolveTopicDocument(db, t2);
  }
  const childWb = lookupWorkbenchRoute(db, t2);
  if (childWb?.root_path) {
    const rest = parts.slice(2).join('/');
    return resolveWorkbenchDocument(db, rest ? `${childWb.id}/${rest}` : childWb.id);
  }
  return null;
}

export function resolveMarkdownDocument(db, routePath) {
  const normalized = normalizeRoutePath(routePath);
  const [root, ...tail] = normalized.split('/').filter(Boolean);
  const rest = tail.join('/');
  let doc;
  if (root === 'agents') doc = resolveAgentDocument(rest);
  else if (root === 'user') doc = resolveUserDocument(rest);
  else if (root === 'topics') doc = resolveTopicDocument(db, rest);
  else if (root === 'entities') doc = resolveEntityDocument(rest, db);
  else if (TYPE_ALIASES.has(root)) doc = resolveEntityDocument(`${root}/${rest}`, db);
  else if (root === 'workbenches' || root === 'workbench') doc = resolveWorkbenchDocument(db, rest);
  else {
    doc = resolveTopicUrlPath(db, normalized);
    if (!doc) {
      const error = new Error('not_found');
      error.status = 404;
      throw error;
    }
  }

  const relPath = doc.relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!ALLOWED_DIRECT_PREFIXES.some((prefix) => relPath.startsWith(prefix))) {
    const error = new Error('forbidden_path');
    error.status = 403;
    throw error;
  }
  const absPath = toAbs(relPath);
  if (!absPath.startsWith(REPO_ROOT + '/')) {
    const error = new Error('forbidden_path');
    error.status = 403;
    throw error;
  }
  return { ...doc, relPath, absPath, url: routeForRelPath(relPath), editable: false };
}

function historyDirFor(absPath) {
  return join(dirname(absPath), '.history', basename(absPath));
}

function historyEntries(absPath, limit = 20) {
  const dir = historyDirFor(absPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => {
      const path = join(dir, name);
      const stat = statSync(path);
      const match = name.match(/^(.+)-([0-9a-f]{12})\.md$/);
      return {
        file: toRepoRel(path),
        sha256: match?.[2] || null,
        createdAt: match?.[1]?.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z') || stat.mtime.toISOString(),
        bytes: stat.size,
      };
    });
}

function workbenchSubstrateForDocument(doc, db = null) {
  if (doc.kind !== 'workbench') return null;
  const rootAbs = statSync(doc.absPath).isDirectory() ? doc.absPath : dirname(doc.absPath);
  const rootRel = toRepoRel(rootAbs);
  const workbenchId = doc.workbenchId || workbenchIdFromRelPath(rootRel);
  const publicUrl = workbenchPublicUrl({ ...(lookupWorkbenchRoute(db, workbenchId) || {}), root_path: rootRel, id: workbenchId });
  const canonical = WORKBENCH_CANONICAL_FILES.map((name) => {
    const absPath = join(rootAbs, name);
    const exists = existsSync(absPath);
    const stat = exists ? statSync(absPath) : null;
    const stem = withoutMd(name);
    return {
      name,
      relPath: `${rootRel}/${name}`,
      url: /^INDEX$/i.test(stem) ? publicUrl : `${publicUrl}/${stem}`,
      exists,
      bytes: stat?.size || 0,
      updatedAt: stat?.mtime?.toISOString?.() || null,
    };
  });
  const entries = readdirSync(rootAbs, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => !WORKBENCH_CANONICAL_FILES.includes(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 40)
    .map((entry) => {
      const absPath = join(rootAbs, entry.name);
      const stat = statSync(absPath);
      const relPath = `${rootRel}/${entry.name}`;
      return {
        name: entry.name,
        relPath,
        kind: entry.isDirectory() ? 'directory' : 'file',
        url: `${publicUrl}/${withoutMd(entry.name)}`,
        bytes: entry.isDirectory() ? 0 : stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    });
  const reportsAbs = join(rootAbs, 'reports');
  let reports = [];
  if (existsSync(reportsAbs)) {
    try {
      reports = readdirSync(reportsAbs)
        .filter((name) => name.toLowerCase().endsWith('.md'))
        .sort()
        .reverse()
        .slice(0, 40)
        .map((name) => {
          const absPath = join(reportsAbs, name);
          const stat = statSync(absPath);
          const relPath = `${rootRel}/reports/${name}`;
          return {
            name,
            relPath,
            url: `${publicUrl}/reports/${withoutMd(name)}`,
            bytes: stat.size,
            updatedAt: stat.mtime.toISOString(),
          };
        });
    } catch { reports = []; }
  }
  const wbRow = lookupWorkbenchRoute(db, workbenchId);
  const existingItems = (wbRow && wbRow.items) || [];
  const existingPaths = new Set(existingItems.map((item) => String(item.path || '').replace(/\\/g, '/')));
  const diskOnly = reports
    .filter((file) => !existingPaths.has(file.relPath))
    .map((file) => ({ path: file.relPath, kind: 'report', title: file.name }));
  const library = buildWorkbenchLibrary({
    ...(wbRow || {}),
    id: workbenchId,
    root_path: rootRel,
    items: [...existingItems, ...diskOnly],
  });
  return {
    id: workbenchId,
    root: rootRel,
    publicUrl: library.publicUrl || publicUrl,
    canonical,
    reports: library.reports.length ? library.reports : reports,
    research: library.research,
    artifacts: library.artifacts,
    library,
    entries,
  };
}

function workbenchIdFromRelPath(relPath) {
  const parts = withoutMd(relPath).split('/').filter(Boolean);
  const match = [...parts].reverse().find((part) => /^wk[_-]/i.test(part));
  return match || '';
}

function frontmatterValue(body, key) {
  const match = String(body || '').match(/^---[ \t]*(?:\r?\n)([\s\S]*?)(?:\r?\n)---[ \t]*(?:\r?\n|$)/);
  if (!match) return '';
  const wanted = String(key || '').toLowerCase();
  for (const line of match[1].split(/\r?\n/)) {
    const row = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (row && row[1].toLowerCase() === wanted) {
      return row[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
    }
  }
  return '';
}

function correctionTargetForDocument(doc, evidence, body = '') {
  if (doc.kind === 'topic') return { targetType: 'topic', targetId: doc.topicSlug };
  if (doc.kind === 'workbench') return { targetType: 'workbench', targetId: doc.workbenchId || workbenchIdFromRelPath(doc.relPath) };
  if (doc.kind === 'entity') {
    const entityId = evidence?.entity?.id || frontmatterValue(body, 'entity_id') || null;
    if (!entityId) return null;
    const targetType = doc.entityType === 'people' ? 'person'
      : doc.entityType === 'companies' ? 'company'
      : doc.entityType === 'places' ? 'place'
      : doc.entityType;
    return { targetType, targetId: entityId };
  }
  return null;
}

function evidenceForDocument(db, doc, body) {
  if (!db || doc?.kind !== 'entity' || body == null) return null;
  try {
    return entityEvidenceForDocument(db, doc, body, {
      participantLimit: VIEWER_ENTITY_TIMELINE_LIMIT,
      mentionLimit: 0,
      timelineLimit: VIEWER_ENTITY_TIMELINE_LIMIT,
      countTotals: true,
    });
  } catch {
    return null;
  }
}

function atomicWrite(absPath, body) {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, body, 'utf8');
  renameSync(tmp, absPath);
}

function snapshotPrior(absPath, prior) {
  if (prior == null) return null;
  const dir = historyDirFor(absPath);
  mkdirSync(dir, { recursive: true });
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replace(/[:.]/g, '-');
  const sha = sha256Hex(prior);
  const file = join(dir, `${stamp}-${sha.slice(0, 12)}.md`);
  writeFileSync(file, prior, 'utf8');
  return { file: toRepoRel(file), sha256: sha, createdAt, bytes: Buffer.byteLength(prior, 'utf8') };
}

export function readMarkdownDocument(db, routePath) {
  const doc = resolveMarkdownDocument(db, routePath);
  let body = null;
  let stat = null;
  if (existsSync(doc.absPath)) {
    stat = statSync(doc.absPath);
    body = readFileSync(doc.absPath, 'utf8');
  }
  else if (doc.kind !== 'topic') {
    const error = new Error('not_found');
    error.status = 404;
    throw error;
  }
  const bodySha = body == null ? null : sha256Hex(body);
  const correctionsWatermark = viewerCorrectionsRevision > 0
    ? `${viewerCorrectionsRevision}:${correctionWatermark(db)}`
    : '0:no-viewer-correction-in-process';
  const cacheKey = documentCacheKey(doc, stat, bodySha, correctionsWatermark);
  const cached = getCachedPayload(cacheKey);
  if (cached) return cached;
  const diskCached = getDiskCachedPayload(cacheKey);
  if (diskCached) {
    setCachedPayload(cacheKey, diskCached);
    return diskCached;
  }
  const evidence = evidenceForDocument(db, doc, body);
  const workbench = doc.kind === 'workbench' && existsSync(doc.absPath)
    ? workbenchSubstrateForDocument(doc, db)
    : (doc.kind === 'topic' && doc.topicSlug
      ? (() => {
        const wb = lookupWorkbenchRoute(db, doc.topicSlug);
        return wb ? workbenchSubstrateForDocument({
          kind: 'workbench',
          absPath: toAbs(wb.root_path),
          workbenchId: wb.id,
          relPath: `${wb.root_path}/INDEX.md`,
        }, db) : null;
      })()
      : null);
  const hasViewerCorrections = viewerCorrectionsRevision > 0
    && !String(correctionsWatermark || '').startsWith('0:');
  const correctionTarget = hasViewerCorrections ? correctionTargetForDocument(doc, evidence, body) : null;
  const corrections = correctionTarget && hasViewerCorrections
    ? listViewerCorrections(db, { ...correctionTarget, targetUrl: doc.url, limit: 20 })
    : [];
  const payload = {
    ...doc,
    body,
    sha256: bodySha,
    history: historyEntries(doc.absPath),
    corrections,
    ...(evidence ? {
      entityId: evidence.entity?.id || null,
      evidence,
    } : {}),
    ...(workbench ? { workbench } : {}),
  };
  payload.projection = body == null ? null : buildViewerProjection(payload, body);
  setCachedPayload(cacheKey, payload);
  setDiskCachedPayload(cacheKey, payload);
  return payload;
}

export function writeMarkdownDocument(db, routePath, body) {
  if (typeof body !== 'string') {
    const error = new Error('body_required');
    error.status = 400;
    throw error;
  }
  const doc = resolveMarkdownDocument(db, routePath);
  const prior = existsSync(doc.absPath) ? readFileSync(doc.absPath, 'utf8') : null;
  const priorSha = prior == null ? null : sha256Hex(prior);
  const nextSha = sha256Hex(body);
  let snapshot = null;
  if (priorSha !== nextSha) {
    snapshot = snapshotPrior(doc.absPath, prior);
    atomicWrite(doc.absPath, body);
    invalidateMarkdownDocumentCache();
    if (doc.kind === 'topic') updateTopicContext(db, doc.topicSlug, body);
  }
  const payload = {
    ok: true,
    ...doc,
    body,
    sha256: nextSha,
    priorSha256: priorSha,
    changed: priorSha !== nextSha,
    snapshot,
    history: historyEntries(doc.absPath),
  };
  const evidence = evidenceForDocument(db, doc, body);
  if (evidence) {
    payload.entityId = evidence.entity?.id || null;
    payload.evidence = evidence;
  }
  payload.projection = buildViewerProjection(payload, body);
  return payload;
}
