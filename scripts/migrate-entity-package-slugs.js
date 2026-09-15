#!/usr/bin/env node
import crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import db from '../lib/db.js';
import { entityPackageNameFromDisplay } from '../lib/context-paths.js';

const rootIndex = process.argv.indexOf('--root');
const repoRoot = rootIndex >= 0 && process.argv[rootIndex + 1]
  ? resolve(process.argv[rootIndex + 1])
  : resolve(dirname(new URL(import.meta.url).pathname), '..');
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.tsv', '.html', '.js', '.mjs', '.css', '.sql']);
const replacements = [];
const moves = [];
const skipped = [];

function rel(abs) {
  return relative(repoRoot, abs);
}

function rowsFor(type) {
  const rows = filesystemRowsFor(type);
  const idsWithFilesystemRows = new Set(rows.map(row => row.id));
  if (type === 'person') {
    for (const row of db.prepare(`SELECT id, display_name AS display_name FROM people`).all()) {
      const normalized = { ...row, id: String(row.id), display_name: row.display_name || String(row.id) };
      if (!idsWithFilesystemRows.has(normalized.id)) rows.push(normalized);
    }
    return rows;
  }
  if (type === 'company') {
    for (const row of db.prepare(`SELECT id, name AS display_name FROM companies`).all()) {
      const normalized = { ...row, id: String(row.id), display_name: row.display_name || String(row.id) };
      if (!idsWithFilesystemRows.has(normalized.id)) rows.push(normalized);
    }
    return rows;
  }
  if (type === 'place') {
    for (const row of db.prepare(`SELECT CAST(id AS TEXT) AS id, name AS display_name FROM places`).all()) {
      const normalized = { ...row, id: String(row.id), display_name: row.display_name || String(row.id) };
      if (!idsWithFilesystemRows.has(normalized.id)) rows.push(normalized);
    }
    return rows;
  }
  throw new Error(`unsupported type: ${type}`);
}

function filesystemRowsFor(type) {
  const root = resolve(repoRoot, 'user', 'contexts', dirFor(type));
  if (!existsSync(root)) return [];
  const rows = [];
  for (const name of readdirSync(root)) {
    const contextAbs = join(root, name, 'context.md');
    if (!existsSync(contextAbs)) continue;
    const text = readFileSync(contextAbs, 'utf8').slice(0, 4000);
    const entityId = frontmatterValue(text, 'entity_id') || name.replace(/--[0-9a-f]{8}$/i, '');
    const displayName = frontmatterValue(text, 'display_name') || firstHeading(text) || entityId;
    rows.push({ id: String(entityId), display_name: displayName, current_package: name });
  }
  return rows;
}

function frontmatterValue(text, key) {
  if (!text.startsWith('---\n')) return '';
  const end = text.indexOf('\n---', 4);
  if (end < 0) return '';
  const fm = text.slice(4, end);
  const line = fm.split(/\r?\n/).find(value => value.startsWith(`${key}:`));
  if (!line) return '';
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
}

function firstHeading(text) {
  const match = text.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() || '';
}

function dirFor(type) {
  if (type === 'person') return 'people';
  if (type === 'company') return 'companies';
  if (type === 'place') return 'places';
  throw new Error(`unsupported type: ${type}`);
}

function tableFor(type) {
  if (type === 'person') return 'people';
  if (type === 'company') return 'companies';
  if (type === 'place') return 'places';
  throw new Error(`unsupported type: ${type}`);
}

function contextPath(type, packageName) {
  return `user/contexts/${dirFor(type)}/${packageName}/context.md`;
}

function moveDir(fromRel, toRel) {
  if (fromRel === toRel) {
    skipped.push({ from: fromRel, to: toRel, reason: 'already canonical' });
    return;
  }
  const fromAbs = resolve(repoRoot, fromRel);
  const toAbs = resolve(repoRoot, toRel);
  if (!existsSync(fromAbs)) {
    skipped.push({ from: fromRel, to: toRel, reason: 'source missing' });
    return;
  }
  if (existsSync(toAbs)) {
    const duplicateRel = `${toRel}/legacy-duplicates/${fromRel.split('/').pop()}`;
    const duplicateAbs = resolve(repoRoot, duplicateRel);
    if (existsSync(duplicateAbs)) {
      skipped.push({ from: fromRel, to: duplicateRel, reason: 'duplicate already preserved' });
      return;
    }
    moves.push({ from: fromRel, to: duplicateRel, duplicate_of: toRel });
    replacements.push([fromRel, duplicateRel]);
    if (!APPLY) return;
    mkdirSync(dirname(duplicateAbs), { recursive: true });
    renameSync(fromAbs, duplicateAbs);
    return;
  }
  moves.push({ from: fromRel, to: toRel });
  replacements.push([fromRel, toRel]);
  if (!APPLY) return;
  mkdirSync(dirname(toAbs), { recursive: true });
  renameSync(fromAbs, toAbs);
}

function walk(dirAbs) {
  if (!existsSync(dirAbs)) return [];
  const out = [];
  for (const name of readdirSync(dirAbs)) {
    const abs = join(dirAbs, name);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

function rewriteFile(abs) {
  if (!TEXT_EXTENSIONS.has(extname(abs))) return false;
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return false;
  }
  let next = text;
  for (const [from, to] of replacements) {
    next = next.split(from).join(to);
    next = next.split(`~/robotdojo/${from}`).join(`~/robotdojo/${to}`);
  }
  if (next === text) return false;
  if (APPLY) writeFileSync(abs, next);
  return true;
}

function yamlValue(value) {
  return JSON.stringify(String(value || ''));
}

function ensureFrontmatter(type, row, contextRel) {
  const abs = resolve(repoRoot, contextRel);
  if (!existsSync(abs)) return false;
  let text = readFileSync(abs, 'utf8');
  if (text.startsWith('---\n')) return false;
  const frontmatter = [
    '---',
    `entity_type: ${type}`,
    `entity_id: ${yamlValue(row.id)}`,
    `display_name: ${yamlValue(row.display_name)}`,
    '---',
    '',
  ].join('\n');
  if (APPLY) writeFileSync(abs, `${frontmatter}${text}`);
  return true;
}

function updateDbPath(type, row, targetContext) {
  if (!APPLY) return;
  try {
    db.prepare(`UPDATE ${tableFor(type)} SET context_file_path = ? WHERE CAST(id AS TEXT) = ?`)
      .run(`~/robotdojo/${targetContext}`, row.id);
  } catch {
    // Local schema variations are tolerated; filesystem path is the durable output.
  }
}

function rewriteDbTextColumns() {
  if (!APPLY || replacements.length === 0) return;
  const updates = [
    ['workbenches', ['root_path', 'resume_path', 'metadata']],
    ['workbench_items', ['path', 'metadata']],
    ['workbench_promotions', ['source_path', 'target_path', 'metadata']],
    ['chunks', ['source_id', 'content', 'metadata']],
  ];
  for (const [table, columns] of updates) {
    for (const column of columns) {
      try {
        const rows = db.prepare(`SELECT rowid, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all();
        const stmt = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
        for (const row of rows) {
          let next = String(row.value || '');
          for (const [from, to] of replacements) {
            next = next.split(from).join(to);
            next = next.split(`~/robotdojo/${from}`).join(`~/robotdojo/${to}`);
          }
          if (next !== row.value) stmt.run(next, row.rowid);
        }
      } catch {
        // Table or column may be absent in temp DBs.
      }
    }
  }
}

for (const type of ['person', 'company', 'place']) {
  for (const row of rowsFor(type)) {
    const packageName = entityPackageNameFromDisplay(row.id, row.display_name);
    const sourceRoot = `user/contexts/${dirFor(type)}/${row.current_package || row.id}`;
    const targetRoot = `user/contexts/${dirFor(type)}/${packageName}`;
    const targetContext = contextPath(type, packageName);
    moveDir(sourceRoot, targetRoot);
    updateDbPath(type, row, targetContext);
    if (APPLY) ensureFrontmatter(type, row, targetContext);
  }
}

let rewrittenFiles = 0;
if (replacements.length) {
  for (const root of ['user/contexts', 'user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/st_8567dd77']) {
    const abs = resolve(repoRoot, root);
    for (const file of walk(abs)) {
      if (rewriteFile(file)) rewrittenFiles++;
    }
  }
}
rewriteDbTextColumns();

const payload = {
  apply: APPLY,
  moves: moves.length,
  skipped: skipped.length,
  rewritten_files: rewrittenFiles,
  replacement_hash: crypto.createHash('sha1').update(JSON.stringify(replacements)).digest('hex').slice(0, 12),
  sample_moves: moves.slice(0, 25),
  sample_skipped: skipped.slice(0, 25),
};
if (VERBOSE) {
  payload.all_moves = moves;
  payload.all_skipped = skipped;
}
console.log(JSON.stringify(payload, null, 2));
