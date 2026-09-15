#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { USER_MEMORY_DIR } from '../lib/robotdojo-paths.js';

const LOG_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{12}\.md$/;
const query = process.argv.slice(2).join(' ').trim().toLowerCase();

if (!query) {
  process.exit(1);
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return {};
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return {};
  const end = lines.indexOf('---', 1);
  if (end < 0) return {};

  const fm = {};
  for (let i = 1; i < end; i += 1) {
    const match = lines[i].match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (match) fm[match[1]] = match[2].trim();
  }
  return fm;
}

const logDir = join(USER_MEMORY_DIR, 'log');
const rows = [];

if (existsSync(logDir)) {
  const files = readdirSync(logDir).filter((name) => LOG_NAME_RE.test(name)).sort().reverse();
  for (const name of files) {
    const content = readFileSync(join(logDir, name), 'utf8');
    if (!content.toLowerCase().includes(query)) continue;
    const fm = parseFrontmatter(content);
    rows.push(`${name} | ${fm.type || ''} | ${fm.name || ''} | ${fm.description || ''}`);
  }
}

if (!rows.length) {
  process.exit(1);
}

process.stdout.write(`${rows.join('\n')}\n`);
