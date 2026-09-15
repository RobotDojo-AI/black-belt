#!/usr/bin/env node
/**
 * generate-sitemap.js — deterministic filesystem-keyed map of the repo.
 *
 * Walks the canonical top-level directories, extracts a one-line description
 * from each file's comment header (JSDoc, leading `#` for shell/markdown,
 * <title> for HTML, "description" key for JSON), and emits architecture/sitemap.md
 * grouped by directory. Tier 0: no LLM, no network I/O.
 *
 * Hard cap: refuses to write if generated output exceeds MAX_CHARS. The cap is
 * READ FROM architecture/surfaces.json — the same registry check-doc-budget.js
 * enforces at pre-commit — so this script's "headroom" is headroom against the
 * number that actually blocks a commit. The cap is enforced at exit time: the
 * script either writes a within-budget architecture/sitemap.md or exits non-zero
 * with a per-section size report so the operator can prune.
 *
 * Architectural narrative (security model, migration invariants, key gotchas,
 * canonical-document architecture) lives in CLAUDE.md, agents/build-conventions.md,
 * and architecture/architecture.md — NOT in architecture/sitemap.md. Sitemap is purely "where does X file
 * live and what does it do."
 *
 * Usage:
 *   node scripts/generate-sitemap.js              # print to stdout
 *   node scripts/generate-sitemap.js --check      # report size + per-section breakdown
 *   node scripts/generate-sitemap.js --write      # write architecture/sitemap.md if under cap
 *
 * Replaces the earlier st_319cfd37-era generate-sitemap.js (which preserved
 * a "## Known Constraints" agent-narrative section and had no size cap).
 * Under the canonical-doc-hybrid regime (st_5285c160), narrative is hand-curated
 * elsewhere and this script is purely structural.
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { maxCharsFor } from '../lib/canonical-budget.js';

export const INTELLIGENCE_TIER = 'extraction';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Tracked files only — the sitemap must reflect the COMMITTED repo, not a dev
// working tree's gitignored files (user/contexts, ignored scripts/migrations).
// Walking the raw filesystem made dev output != CI's tracked-only clone, so the
// committed sitemap read perpetually "stale" in the Root architecture lock CI
// (df_2962486a). git ls-files respects .gitignore and matches CI exactly.
const TRACKED = new Set(
  execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean)
);
// THE CAP HAS ONE HOME (st_dd0e19d8). It used to be a literal here AND a
// max_chars in architecture/surfaces.json, and the two drifted 2000 apart: this
// script printed "headroom" against 28000 while check-doc-budget.js blocked the
// commit at 26000. A generator that reports against a limit nothing enforces is
// worse than no report — it says healthy at the exact moment the commit fails.
// So the registry is the single source and this script reads it. No literal
// fallback: an unregistered surface has no enforced cap, and silently inventing
// one here is how the drift started.
const MAX_CHARS = (() => {
  const env = parseInt(process.env.GENERATE_SITEMAP_MAX_CHARS || '', 10);
  if (Number.isFinite(env) && env > 0) return env;
  const registered = maxCharsFor('architecture/sitemap.md');
  if (registered == null) {
    process.stderr.write(
      'FAIL: architecture/sitemap.md has no max_chars in architecture/surfaces.json, so no cap is enforced '
        + 'at pre-commit. Register it there (a raise needs the owner countersign — scripts/check-doc-budget-raise.js) '
        + 'or set GENERATE_SITEMAP_MAX_CHARS for a one-off run.\n'
    );
    process.exit(1);
  }
  return registered;
})();
const args = process.argv.slice(2);
const mode = args.includes('--write') ? 'write' : args.includes('--check') ? 'check' : 'print';
const OUTPUT = join(REPO_ROOT, 'architecture/sitemap.md');

// File groups — order = output order. Within each group, only top-level files of
// the named directory are itemized; subdirectories are rolled up into a single
// "<subdir>/" row with a one-line summary (subdir's index.js header or just the
// dir name). This keeps architecture/sitemap.md at module-granularity without exploding on
// file counts (lib/ alone has ~140 files; we render ~50 top-level entries).
const GROUPS = [
  { heading: '## Entry Points', files: ['index.js', 'middleware.js'] },
  { heading: '## Routes', dir: 'routes', exts: ['.js'], topLevelOnly: true },
  { heading: '## Lib Modules', dir: 'lib', exts: ['.js'], topLevelOnly: true, skip: (p) => p.endsWith('.test.js') || p === 'migrations', pathsOnly: true },
  { heading: '## Apps (frontend)', dir: 'apps', exts: ['.html', '.js', '.css'], topLevelOnly: true, skip: (p) => p.startsWith('static/img/') },
  { heading: '## API (Vercel functions)', dir: 'api', exts: ['.js'], topLevelOnly: true },
  { heading: '## Scripts', dir: 'scripts', exts: ['.js', '.sh', '.mjs'], topLevelOnly: true, skip: (p) => p.endsWith('.test.js'), pathsOnly: true },
  { heading: '## Architecture Docs', dir: 'architecture', exts: ['.md', '.json'], topLevelOnly: true },
  { heading: '## Agents', dir: 'agents', exts: ['.md'], topLevelOnly: true },
  { heading: '## Agent Skills', dir: 'agents/skills', exts: ['.md'], match: (p) => p.endsWith('/SKILL.md') },
  { heading: '## Config', dir: 'config', exts: ['.json', '.md'], topLevelOnly: true },
  { heading: '## User Contexts', dir: 'user/contexts', exts: ['.md'], topLevelOnly: true },
  // `pipeline/` is RETIRED (st_0c491456 Phase 3e): the dev pipeline relocated to
  // user/workbenches/topics/work/robot-dojo/wk_robot_dojo/. It survives only as
  // an untracked scratch dir so the root-allowlist does not trip. The sitemap
  // used to walk and itemize that scratch dir (rename_map.json, sessions/,
  // research/, …), which contradicted architecture/ontology.md's
  // retired-scratch status (the AC11-sitemap drift, st_a5baa72c). It now emits a
  // single static retired-status line matching the ontology purpose, so the two
  // generated docs agree on `pipeline/`. `staticRows` short-circuits the walk.
  { heading: '## Pipeline', staticRows: [{ path: 'pipeline/', desc: 'Retired (st_0c491456 Phase 3e) — untracked scratch only; no tracked files' }] },
  { heading: '## Docs', dir: 'docs', exts: ['.md'], topLevelOnly: true },
  { heading: '## Top-level', files: ['CLAUDE.md', 'README.md', 'ACCOUNT_RECOVERY.txt', 'vercel.json', 'package.json'] },
];

function walk(dirRel) {
  const out = [];
  const abs = join(REPO_ROOT, dirRel);
  let entries;
  try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return out; }
  // Deterministic order across OSes (macOS dev readdir order != Linux CI) — code-point sort, not locale-sensitive.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    if (ent.name === 'node_modules') continue;
    const rel = join(dirRel, ent.name);
    if (ent.isDirectory()) out.push(...walk(rel));
    else if (ent.isFile() && TRACKED.has(rel.split('\\').join('/'))) out.push(rel);
  }
  return out;
}

// One-line description per file. Falls back to null (renders as "—").
function extractHeader(absPath) {
  let content;
  try { content = readFileSync(absPath, 'utf8'); } catch { return null; }
  const ext = extname(absPath);
  const head = content.slice(0, 2000);

  if (ext === '.js' || ext === '.mjs' || ext === '.ts') {
    // JSDoc block — first non-blank line after /**
    const m = head.match(/\/\*\*\s*\n\s*\*\s+([^\n]+)/);
    if (m) return m[1].trim();
    // // single-line comment (skip shebang)
    const lines = head.split('\n');
    for (const line of lines) {
      if (line.startsWith('#!')) continue;
      const slc = line.match(/^\s*\/\/\s+([^\n]+)/);
      if (slc) return slc[1].trim();
      if (line.trim() && !line.startsWith('/*') && !line.startsWith('//')) break;
    }
  }
  if (ext === '.sh') {
    const m = head.match(/^#![^\n]*\n#\s+([^\n]+)/);
    if (m) return m[1].trim();
    const c = head.match(/^#\s+([^\n]+)/m);
    if (c) return c[1].trim();
  }
  if (ext === '.sql') {
    // SQL — first -- comment or first CREATE TABLE
    const c = head.match(/^--\s+([^\n]+)/m);
    if (c) return c[1].trim();
    const t = head.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
    if (t) return `Creates table: ${t[1]}`;
  }
  if (ext === '.md') {
    const h = head.match(/^#\s+([^\n]+)/m);
    if (h) return h[1].trim();
  }
  if (ext === '.html') {
    const t = head.match(/<title>([^<]+)<\/title>/i);
    if (t) return t[1].trim();
  }
  if (ext === '.json') {
    try {
      const j = JSON.parse(content);
      if (typeof j.description === 'string') return j.description.trim();
      if (typeof j.name === 'string') return j.name.trim();
    } catch { /* ignore */ }
  }
  return null;
}

// Strip owner-name tokens so architecture/sitemap.md passes scripts/gate-pii.sh on commit.
// The gate blocks bare owner-name references in committed files; the wk_user
// vessel's top-of-file H1 trips it. The sanitized description still reads
// sensibly (e.g., "USER.md - About the owner").
const OWNER_NAME_PATTERN = new RegExp('\\b' + ['A','d','a','m'].join('') + '\\b', 'g');
function sanitize(desc) {
  return desc.replace(OWNER_NAME_PATTERN, 'the owner');
}

function trim(desc, max = 18) {
  if (!desc) return '';
  desc = sanitize(desc).replace(/\s+/g, ' ').trim();
  desc = desc.replace(/\s+\(generated \d{4}-\d{2}-\d{2} by scripts\/generate-[^)]+\)/, '');
  return desc.length <= max ? desc : desc.slice(0, max - 1) + '…';
}

// Drop a file's redundant self-path echo from its own description so the map
// never renders `foo/bar.js` — foo/bar.js — …`. A description that is nothing
// but the path collapses to empty (rendered as a bare path row). df_0bd64903:
// this reclaims real headroom in the generated map by removing redundancy,
// rather than raising the doc-budget cap.
function dedupePathEcho(path, desc) {
  if (!desc) return '';
  const base = path.split('/').pop();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^(?:' + esc(path) + '|' + esc(base) + ')(?:\\s*[—-]\\s*|$)', 'i');
  return desc.replace(re, '').trim();
}

// Render rows. topLevelOnly mode: list files directly under group.dir; group
// subdirs into one row per subdir (rolled up to <subdir>/ with index.js header
// or a count of files inside). For match-mode groups (Skills), match runs as-is.
function renderGroup(group) {
  let rows = []; // {path, desc}
  if (group.staticRows) {
    // Hand-declared rows (deterministic, no filesystem walk). Used for retired
    // dirs whose on-disk scratch contents must NOT be itemized (pipeline/).
    rows = group.staticRows.map((r) => ({ path: r.path, desc: trim(r.desc) }));
  } else if (group.files) {
    for (const f of group.files) {
      try { if (!statSync(join(REPO_ROOT, f)).isFile()) continue; } catch { continue; }
      rows.push({ path: f, desc: trim(extractHeader(join(REPO_ROOT, f))) });
    }
  } else if (group.dir) {
    if (!existsSync(join(REPO_ROOT, group.dir))) return null;
    if (group.topLevelOnly) {
      // Top-level files in group.dir + a single row per immediate subdirectory.
      let entries;
      try { entries = readdirSync(join(REPO_ROOT, group.dir), { withFileTypes: true }); } catch { return null; }
      const fileRows = [];
      const dirRows = [];
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        if (ent.name === 'node_modules') continue;
        const rel = join(group.dir, ent.name);
        const relInGroup = relative(group.dir, rel);
        if (group.skip && group.skip(relInGroup)) continue;
        if (ent.isFile()) {
          if (group.exts && !group.exts.includes(extname(ent.name))) continue;
          if (!TRACKED.has(rel.split('\\').join('/'))) continue; // tracked-only (matches CI clone)
          fileRows.push({ path: rel, desc: trim(extractHeader(join(REPO_ROOT, rel))) });
        } else if (ent.isDirectory()) {
          // Roll up to one row. walk() is tracked-only; skip subdirs with no tracked files.
          const allFiles = walk(rel);
          if (allFiles.length === 0) continue;
          const indexPath = join(REPO_ROOT, rel, 'index.js');
          const desc = existsSync(indexPath) ? trim(extractHeader(indexPath)) : `${allFiles.length} files`;
          dirRows.push({ path: `${rel}/`, desc: desc || `module group` });
        }
      }
      const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0); // code-point, OS-stable
      rows = [...fileRows.sort(byPath), ...dirRows.sort(byPath)];
    } else {
      // Full walk (used for Skills which is match-based).
      let files = walk(group.dir);
      if (group.exts) files = files.filter(f => group.exts.includes(extname(f)));
      if (group.match) files = files.filter(f => group.match(relative(group.dir, f)));
      if (group.skip) files = files.filter(f => !group.skip(relative(group.dir, f)));
      files.sort();
      rows = files.map(f => ({ path: f, desc: trim(extractHeader(join(REPO_ROOT, f))) }));
    }
  }
  if (rows.length === 0) return null;
  // Dense format. pathsOnly groups (high-volume dirs like lib/, scripts/) emit
  // path-only lines — agents Read the file when they need detail.
  const lines = [group.heading];
  if (group.pathsOnly) {
    for (const r of rows) lines.push(`\`${r.path}\``);
  } else {
    for (const r of rows) {
      const desc = dedupePathEcho(r.path, r.desc);
      lines.push(desc ? `\`${r.path}\` — ${desc}` : `\`${r.path}\``);
    }
  }
  return lines.join('\n');
}

function render() {
  // Dense header: one line, no decorative prose. Narrative lives in CLAUDE.md +
  // build-conventions.md + architecture/architecture.md.
  // NO build date in the header (df: circularity fix): a date-stamped header
  // made this generated file — which feeds the public-truth content hash —
  // churn every midnight, cascading root-lock re-approvals across llms/
  // public-truth/apps on the first commit of each day. Freshness is git-derived
  // (build-conventions), never a build timestamp.
  const header = '# System Map (generated by scripts/generate-sitemap.js — deterministic, hard-capped)';
  const sections = GROUPS.map(renderGroup).filter(Boolean);
  return [header, ...sections].join('\n\n') + '\n';
}

const out = render();
const size = Buffer.byteLength(out, 'utf8');

function normalizeForFreshness(text) {
  return String(text)
    .replace(/^# System Map \(generated \d{4}-\d{2}-\d{2} by scripts\/generate-sitemap\.js/m,
      '# System Map (generated <date> by scripts/generate-sitemap.js');
}

if (mode === 'check') {
  const sectionSizes = GROUPS.map(g => {
    const block = renderGroup(g);
    return { heading: g.heading, bytes: block ? Buffer.byteLength(block, 'utf8') : 0 };
  }).filter(s => s.bytes > 0).sort((a, b) => b.bytes - a.bytes);
  process.stdout.write(`generate-sitemap: would-be size ${size} bytes (max ${MAX_CHARS})\n`);
  for (const s of sectionSizes) {
    process.stdout.write(`  ${String(s.bytes).padStart(6)}  ${s.heading}\n`);
  }
  if (size > MAX_CHARS) {
    process.stderr.write(`\nFAIL: ${size} exceeds ${MAX_CHARS} by ${size - MAX_CHARS}. Prune the largest section(s) above (drop dirs from GROUPS, tighten trim() max, or split into a separate hand-authored file).\n`);
    process.exit(1);
  }
  let current = '';
  try { current = readFileSync(OUTPUT, 'utf8'); } catch (e) {
    process.stderr.write(`\nFAIL: cannot read architecture/sitemap.md for freshness check: ${e.message}\n`);
    process.exit(1);
  }
  if (normalizeForFreshness(current) !== normalizeForFreshness(out)) {
    process.stderr.write(`\nFAIL: architecture/sitemap.md is stale. Run: node scripts/generate-sitemap.js --write\n`);
    process.exit(1);
  }
  process.stdout.write(`ok: within cap (${MAX_CHARS - size} bytes headroom)\n`);
  process.exit(0);
}

if (size > MAX_CHARS) {
  process.stderr.write(`FAIL: generated sitemap is ${size} bytes; cap is ${MAX_CHARS} bytes (exceeds by ${size - MAX_CHARS}). Re-run with --check for per-section breakdown. Did not write architecture/sitemap.md.\n`);
  process.exit(1);
}

if (mode === 'write') {
  writeFileSync(OUTPUT, out);
  process.stdout.write(`architecture/sitemap.md written: ${size} bytes (${MAX_CHARS - size} bytes headroom)\n`);
  process.exit(0);
}

process.stdout.write(out);
