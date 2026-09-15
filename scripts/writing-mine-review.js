#!/usr/bin/env node
/**
 * Mine conversation / memory feedback into a review pack.
 * Does NOT write voice/structure/formatting files. Owner yes required.
 */
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(homedir(), 'robotdojo');
const OUT_DIR = join(ROOT, 'user/workbenches/user/wk_user/user-voice/reviews');

const HITS = /my voice|in my voice|too clipped|too llm|do not pretend|nanny|acronym|sound like me/i;

export function mineText(text, source) {
  const lines = String(text || '').split('\n');
  const hits = [];
  for (const line of lines) {
    if (HITS.test(line) && line.trim().length > 12) {
      hits.push({ source, line: line.trim().slice(0, 400), speaker: /miyagi|agent voice/i.test(line) ? 'miyagi' : 'owner' });
    }
  }
  return hits;
}

export function renderReviewPack(hits) {
  const rows = hits.map((h, i) => `${i + 1}. [${h.speaker}] ${h.line}\n   source: ${h.source}`).join('\n\n');
  return `# Writing review pack\n\nNothing below lands in voice/structure/formatting until you say yes.\n\n${rows || '_No hits._'}\n`;
}

export function writeReviewPack(hits, filename) {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, filename || `review-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(path, renderReviewPack(hits));
  return path;
}

function scanMemory() {
  const dir = join(ROOT, 'user/memory/log');
  if (!existsSync(dir)) return [];
  const hits = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.md')).slice(-80)) {
    hits.push(...mineText(readFileSync(join(dir, name), 'utf8'), `memory/${name}`));
  }
  return hits;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hits = scanMemory();
  const path = writeReviewPack(hits);
  process.stdout.write(`${path}\n${hits.length} hits. No voice files written.\n`);
}
