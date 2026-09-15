#!/usr/bin/env node
// scripts/canonical-class.js — CLI surface for canonical classification lookup.
//
// Story st_a78848a0. Reads architecture/surfaces.json (or whichever path
// $ROBOTDOJO_SURFACES_PATH points at) and prints the class for a given path,
// exit 0 on hit. Exits 1 with `unclassified surface: <path>` on stderr when
// the path is not registered.
//
// Usage:
//   node scripts/canonical-class.js agents/agents.md
//   node scripts/canonical-class.js ~/.claude/agents/Tantei.md

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';

const REPO_ROOT = resolve(homedir(), 'robotdojo');
const SURFACES_PATH = process.env.ROBOTDOJO_SURFACES_PATH
  || resolve(REPO_ROOT, 'architecture/surfaces.json');

function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  if (isAbsolute(p)) return p;
  return resolve(REPO_ROOT, p);
}

function canonicalKey(p) {
  const abs = expandPath(p);
  if (abs.startsWith(REPO_ROOT + '/')) return abs.slice(REPO_ROOT.length + 1);
  if (abs === REPO_ROOT) return '.';
  if (abs.startsWith(homedir() + '/')) return '~/' + abs.slice(homedir().length + 1);
  return abs;
}

function canonicalClass(path) {
  statSync(SURFACES_PATH);
  const registry = JSON.parse(readFileSync(SURFACES_PATH, 'utf8'));
  const key = canonicalKey(path);
  let entry = null;
  for (const surface of registry.surfaces || []) {
    if (canonicalKey(surface.path) === key) entry = surface;
  }
  return entry ? entry.class : null;
}

const path = process.argv[2];
if (!path) {
  process.stderr.write('usage: canonical-class.js <path>\n');
  process.exit(2);
}

const klass = canonicalClass(path);
if (!klass) {
  process.stderr.write(`unclassified surface: ${path}\n`);
  process.exit(1);
}

process.stdout.write(`${klass}\n`);
process.exit(0);
