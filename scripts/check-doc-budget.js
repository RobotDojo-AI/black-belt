#!/usr/bin/env node
// scripts/check-doc-budget.js — HARD pre-commit budget gate.
//
// Stories st_a78848a0 + st_ae536261. Reads max_chars from canonical-surfaces.json
// (NOT the retired budget manifest), stats each file, exits non-zero on any
// overrun. NO escape hatch. NO escape-hatch fields. The schema gate in
// check-registry-schema.js guarantees max_chars is declared; this gate enforces
// the measured value.
//
// CLI: node scripts/check-doc-budget.js [--registry <path>]
// Default registry: architecture/surfaces.json
// Exit: 0 on all within budget, 1 on any overrun.
//
// Tier: orchestration.

import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

let registryPath = resolve(REPO_ROOT, 'architecture/surfaces.json');
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--registry' && process.argv[i + 1]) {
    const p = process.argv[i + 1];
    registryPath = isAbsolute(p) ? p : resolve(process.cwd(), p);
    i++;
  }
}

function expandPath(p) {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (isAbsolute(p)) return p;
  return resolve(REPO_ROOT, p);
}

const data = JSON.parse(readFileSync(registryPath, 'utf8'));
const surfaces = data.surfaces || [];

let anyOver = false;
const lines = [];

for (const entry of surfaces) {
  // Log surfaces have max_chars=null and are skipped by design (they are
  // append-only chains; growth is bounded by external mechanisms).
  if (entry.max_chars == null) continue;
  if (entry.class === 'log') continue;

  const abs = expandPath(entry.path);
  let actual;
  try {
    const st = statSync(abs);
    if (st.isDirectory()) continue;
    actual = st.size;
  } catch (err) {
    if (err.code === 'ENOENT') {
      lines.push({ path: entry.path, actual: 0, max: entry.max_chars, status: 'MISSING' });
      continue;
    }
    throw err;
  }
  const max = entry.max_chars;
  const over = actual - max;
  if (over > 0) {
    // NO escape hatch. Any over-budget surface fails the gate unconditionally.
    lines.push({ path: entry.path, actual, max, status: `OVER by ${over}` });
    anyOver = true;
  } else {
    lines.push({ path: entry.path, actual, max, status: 'OK' });
  }
}

const out = anyOver ? process.stderr : process.stdout;
const w = Math.max(...lines.map((l) => l.path.length), 5);
out.write(`\n${'PATH'.padEnd(w)}  ACTUAL    MAX       STATUS\n`);
out.write(`${'-'.repeat(w)}  --------  --------  ------\n`);
for (const l of lines) {
  out.write(
    `${l.path.padEnd(w)}  ${String(l.actual).padStart(8)}  ${String(l.max).padStart(8)}  ${l.status}\n`,
  );
}

if (anyOver) {
  process.stderr.write(
    `\n[check-doc-budget] FAIL — over-budget surface(s) above. Distill the doc in a story-reviewed edit, OR raise max_chars in architecture/surfaces.json with owner countersign in the commit message.\n`,
  );
  process.exit(1);
}

process.exit(0);
