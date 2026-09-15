#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function read(rel) {
  return readFileSync(join(repoRoot, rel), 'utf8');
}

export function exists(rel) {
  return existsSync(join(repoRoot, rel));
}

export function fail(messages) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [messages].filter(Boolean);
  if (list.length) {
    console.error(list.map((msg) => `FAIL ${msg}`).join('\n'));
    process.exit(1);
  }
  console.log('PASS');
}

export function assertIncludes(file, needles, label = file) {
  const src = read(file);
  return needles
    .filter((needle) => !src.includes(needle))
    .map((needle) => `${label} missing ${needle}`);
}

export function assertNotIncludes(file, needles, label = file) {
  const src = read(file);
  return needles
    .filter((needle) => src.includes(needle))
    .map((needle) => `${label} must not include ${needle}`);
}

export function routeScripts(file) {
  const src = read(file);
  return [...src.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map((m) => m[1]);
}

export function routeStyles(file) {
  const src = read(file);
  return [...src.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["'][^>]*>/g)].map((m) => m[1]);
}

export function changedFiles() {
  const out = execSync('git diff --name-only HEAD', { cwd: repoRoot, encoding: 'utf8' });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function writeJson(rel, data) {
  writeFileSync(join(repoRoot, rel), JSON.stringify(data, null, 2) + '\n');
}

export function relPath(absOrRel) {
  return absOrRel.startsWith(repoRoot) ? relative(repoRoot, absOrRel) : absOrRel;
}

export function fileLabel(file) {
  return basename(file);
}
