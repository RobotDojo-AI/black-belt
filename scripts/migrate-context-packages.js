#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const rootIndex = process.argv.indexOf('--root');
const repoRoot = rootIndex >= 0 && process.argv[rootIndex + 1]
  ? resolve(process.argv[rootIndex + 1])
  : resolve(dirname(new URL(import.meta.url).pathname), '..');
const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const moved = [];
const skipped = [];
const replacements = [];

function rel(abs) {
  return relative(repoRoot, abs);
}

function sameContent(a, b) {
  try {
    return readFileSync(a, 'utf8') === readFileSync(b, 'utf8');
  } catch {
    return false;
  }
}

function moveFile(fromAbs, toAbs) {
  if (!existsSync(fromAbs)) return false;
  replacements.push([rel(fromAbs), rel(toAbs)]);
  if (existsSync(toAbs)) {
    if (sameContent(fromAbs, toAbs)) {
      skipped.push({ from: rel(fromAbs), to: rel(toAbs), reason: 'target already exists with same content' });
      return false;
    }
    throw new Error(`target exists: ${rel(toAbs)} for ${rel(fromAbs)}`);
  }
  if (!APPLY) {
    moved.push({ from: rel(fromAbs), to: rel(toAbs), dry_run: true });
    return true;
  }
  mkdirSync(dirname(toAbs), { recursive: true });
  renameSync(fromAbs, toAbs);
  moved.push({ from: rel(fromAbs), to: rel(toAbs) });
  return true;
}

function moveDir(fromAbs, toAbs) {
  if (!existsSync(fromAbs)) return false;
  if (existsSync(toAbs)) {
    skipped.push({ from: rel(fromAbs), to: rel(toAbs), reason: 'target directory already exists' });
    return false;
  }
  if (!APPLY) {
    moved.push({ from: rel(fromAbs), to: rel(toAbs), dry_run: true });
    return true;
  }
  mkdirSync(dirname(toAbs), { recursive: true });
  renameSync(fromAbs, toAbs);
  moved.push({ from: rel(fromAbs), to: rel(toAbs) });
  return true;
}

function walk(dirAbs) {
  if (!existsSync(dirAbs)) return [];
  const out = [];
  for (const name of readdirSync(dirAbs)) {
    const abs = join(dirAbs, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

function migrateTopics() {
  const root = join(repoRoot, 'user', 'contexts', 'topics');
  for (const file of walk(root)) {
    if (!file.endsWith('.md')) continue;
    if (file.endsWith('/context.md')) continue;
    if (file.includes('/workbenches/')) continue;
    if (file.includes('/framings/')) continue;
    if (file.includes('-framings/')) continue;
    const parent = dirname(file);
    const slug = file.slice(parent.length + 1, -3);
    moveFile(file, join(parent, slug, 'context.md'));
  }

  const t1Dirs = existsSync(root) ? readdirSync(root).map(name => join(root, name)).filter(abs => existsSync(abs) && statSync(abs).isDirectory()) : [];
  for (const t1Dir of t1Dirs) {
    for (const name of readdirSync(t1Dir)) {
      if (!name.endsWith('-framings')) continue;
      const slug = name.replace(/-framings$/, '');
      moveDir(join(t1Dir, name), join(t1Dir, slug, 'framings'));
    }
  }
}

function collectExistingTopicMappings() {
  const root = join(repoRoot, 'user', 'contexts', 'topics');
  if (!existsSync(root)) return;
  for (const file of walk(root)) {
    if (!file.endsWith('/context.md')) continue;
    if (file.includes('/workbenches/')) continue;
    const ownerDir = dirname(file);
    const slug = ownerDir.slice(dirname(ownerDir).length + 1);
    const legacy = join(dirname(ownerDir), `${slug}.md`);
    replacements.push([rel(legacy), rel(file)]);
  }
}

function migrateEntities(typeDir) {
  const root = join(repoRoot, 'user', 'contexts', typeDir);
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    if (!name.endsWith('.md')) continue;
    if (!statSync(abs).isFile()) continue;
    const id = name.replace(/\.md$/, '');
    const target = join(root, id, 'context.md');
    moveFile(abs, target);
  }
}

migrateTopics();
migrateEntities('people');
migrateEntities('companies');
migrateEntities('places');
collectExistingTopicMappings();

function rewriteText(value) {
  let next = String(value || '');
  for (const [from, to] of replacements) {
    next = next.split(from).join(to);
    next = next.split(`~/robotdojo/${from}`).join(`~/robotdojo/${to}`);
  }
  return next;
}

function rewriteFile(abs) {
  if (!/\.(md|txt|json|csv|tsv|html|js|mjs|css|sql)$/.test(abs)) return false;
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return false;
  }
  const next = rewriteText(text);
  if (next === text) return false;
  if (APPLY) writeFileSync(abs, next);
  return true;
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

let rewrittenDbCells = 0;
if (APPLY && replacements.length) {
  const { default: db } = await import('../lib/db.js');
  const updates = [
    ['user_topics', ['context_md']],
    ['people', ['context_file_path']],
    ['companies', ['context_file_path']],
    ['places', ['context_file_path']],
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
          const next = rewriteText(row.value);
          if (next !== String(row.value || '')) {
            stmt.run(next, row.rowid);
            rewrittenDbCells++;
          }
        }
      } catch {
        // Table or column may not exist in dev/test DBs.
      }
    }
  }
}

const payload = {
  apply: APPLY,
  moved: moved.length,
  skipped: skipped.length,
  rewritten_files: rewrittenFiles,
  rewritten_db_cells: rewrittenDbCells,
  sample_moved_paths: moved.slice(0, 25),
  sample_skipped_paths: skipped.slice(0, 25),
};
if (VERBOSE) {
  payload.moved_paths = moved;
  payload.skipped_paths = skipped;
}
console.log(JSON.stringify(payload, null, 2));
