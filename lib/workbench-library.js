/**
 * Workbench research library — the browsable inventory a user opens at /t1 or /t1/t2.
 *
 * Reports = published snapshots (reports/*.md).
 * Research = source research notes (substrate/research/**).
 * Artifacts = charts, dashboards, datasets, PDFs, renderings.
 */
import { basename, extname } from 'node:path';
import { classifyItem } from './workbench-files.js';
import { workbenchPublicUrl } from './workbenches.js';

const CANONICAL_NAMES = new Set([
  'INDEX.md', 'SYNTHESIS.md', 'LOG.md', 'SESSION-STATUS.md', 'REPORTS.md',
]);

const ARTIFACT_KINDS = new Set([
  'visualization', 'rendering', 'dataset', 'generated_view', 'database',
]);

const ARTIFACT_EXTS = new Set([
  '.html', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.csv', '.tsv', '.xlsx', '.xls',
]);

export function workbenchItemUrl(workbench, relPath) {
  const root = String(workbench?.root_path || '').replace(/\\/g, '/').replace(/\/$/, '');
  const path = String(relPath || '').replace(/\\/g, '/');
  const rest = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : basename(path);
  const base = workbenchPublicUrl(workbench);
  return `${base}/${rest.replace(/\.md$/i, '')}`;
}

export function libraryBucketForPath(path, kind = '') {
  const p = String(path || '').replace(/\\/g, '/');
  const name = basename(p);
  if (CANONICAL_NAMES.has(name) && !/\/reports\//i.test(p)) return null;
  const resolvedKind = kind || classifyItem(p);
  if (resolvedKind === 'report' || /\/reports\//i.test(p)) return 'reports';
  if (resolvedKind === 'research' || /\/research\//i.test(p)) return 'research';
  if (ARTIFACT_KINDS.has(resolvedKind) || ARTIFACT_EXTS.has(extname(p).toLowerCase())) return 'artifacts';
  return null;
}

function toEntry(workbench, item) {
  const path = item.path || item.relPath;
  return {
    name: item.title || item.name || basename(path || ''),
    path,
    kind: item.kind || classifyItem(path || ''),
    url: workbenchItemUrl(workbench, path),
    updatedAt: item.updated_at || item.updatedAt || item.metadata?.mtime_ms || null,
  };
}

function itemKey(item = {}, bucket = '') {
  const path = String(item.path || item.relPath || '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .toLowerCase();
  const name = String(item.name || item.title || basename(path) || '').toLowerCase();
  return `${bucket}:${name || path}`;
}

export function buildWorkbenchLibrary(workbench = {}) {
  const reports = [];
  const research = [];
  const artifacts = [];
  const seen = new Set();
  for (const item of workbench.items || []) {
    const bucket = libraryBucketForPath(item.path, item.kind);
    if (!bucket) continue;
    const key = itemKey(item, bucket);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    const entry = toEntry(workbench, item);
    if (bucket === 'reports') reports.push(entry);
    else if (bucket === 'research') research.push(entry);
    else artifacts.push(entry);
  }
  const byNameDesc = (a, b) => String(b.name).localeCompare(String(a.name));
  reports.sort(byNameDesc);
  research.sort(byNameDesc);
  artifacts.sort(byNameDesc);
  return {
    publicUrl: workbenchPublicUrl(workbench),
    reports,
    research,
    artifacts,
    counts: {
      reports: reports.length,
      research: research.length,
      artifacts: artifacts.length,
    },
  };
}
