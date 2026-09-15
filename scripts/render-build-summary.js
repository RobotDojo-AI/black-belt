#!/usr/bin/env node
/**
 * render-build-summary.js — deterministic build-summary renderer.
 *
 * Usage:
 *   node scripts/render-build-summary.js <path-to-03-build.md>
 *
 * Reads the build report (03-build.md) and the sibling meta.json + 03b-criteria.md
 * (if present). Emits the canonical build-report shape per
 * config/formatting/claude-code.md Example 1:
 *
 *   <leading prose status line>
 *
 *   1) <finding 1>
 *   2) <finding 2>
 *   ...
 *
 *   Next step is <next action>.
 *
 * AC-39 (st_0c491456): pipeline /build presents through this helper so the
 * shape matches the formatting contract without depending on model memory.
 *
 * Behavior when 03-build.md doesn't exist yet (build phase mid-flight): emit a
 * canonical-shape scaffold derived from meta.json so the renderer remains
 * verifiable at any pipeline state. The scaffold still carries a numbered
 * item and a "Next step" line — the structural contract is unconditional.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

const args = process.argv.slice(2);
const buildPath = args[0];

if (!buildPath) {
  process.stderr.write('Usage: render-build-summary.js <path-to-03-build.md>\n');
  process.exit(1);
}

const storyDir = dirname(buildPath);
const metaPath = join(storyDir, 'meta.json');
const criteriaPath = join(storyDir, '03b-criteria.md');

let meta = {};
if (existsSync(metaPath)) {
  try { meta = JSON.parse(readFileSync(metaPath, 'utf8')); } catch {}
}
const storyId = meta.story_id || basename(storyDir);

// Slice "## Heading" up to next "## " or EOF.
function sliceSection(src, heading) {
  const lines = src.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === heading) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

// Extract bullet items from a section (lines starting with `- `). Up to `limit`.
function extractBullets(section, limit = 6) {
  if (!section) return [];
  const items = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^[-*]\s+(.*)$/);
    if (m) {
      const text = m[1].trim();
      if (text) items.push(text);
      if (items.length >= limit) break;
    }
  }
  return items;
}

// Try to find a "next" line — a line under ## Next step / Next or a "Next:" marker.
function extractNextStep(text) {
  // Explicit section.
  const sec = sliceSection(text, '## Next step') || sliceSection(text, '## Next');
  if (sec) {
    const firstLine = sec.split('\n').map(l => l.trim()).find(l => l.length > 0);
    if (firstLine) return firstLine.replace(/^[-*]\s+/, '');
  }
  // Inline "Next:" marker.
  const m = text.match(/^Next:?\s+(.+)$/m);
  if (m) return m[1].trim();
  return null;
}

// Pull a count from 03b-criteria.md if present.
function readCriteriaSummary() {
  if (!existsSync(criteriaPath)) return null;
  try {
    const c = readFileSync(criteriaPath, 'utf8');
    const m = c.match(/VERDICT:\s*(PASS|FAIL)/i);
    const verdict = m ? m[1].toUpperCase() : null;
    // count lines like "PASS" or "FAIL" per-criterion if present
    const passCount = (c.match(/^\s*✓|^\s*PASS\b/gm) || []).length;
    const failCount = (c.match(/^\s*✗|^\s*FAIL\b/gm) || []).length;
    return { verdict, passCount, failCount };
  } catch {
    return null;
  }
}

const out = [];

if (!existsSync(buildPath)) {
  // Scaffold path — build artifact not yet written. Emit canonical shape so
  // the renderer is verifiable independent of pipeline progress.
  const stage = meta.stage || 'unknown';
  out.push(`Build artifact not yet written for ${storyId} (current stage: ${stage}).`);
  out.push('');
  out.push('1) Plan is sealed and approved.');
  out.push('2) Build phase has not produced 03-build.md yet.');
  out.push('3) Run /build to produce the build artifact.');
  out.push('');
  out.push('Next step is to run /build, which writes 03-build.md and 03b-criteria.md, then seals the build stage.');
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
}

const text = readFileSync(buildPath, 'utf8');
const criteria = readCriteriaSummary();

// Leading prose status line — pull a one-liner status if available, else compose.
const summaryLine = (() => {
  const sec = sliceSection(text, '## Summary')
    || sliceSection(text, '## Shipped')
    || sliceSection(text, '## Result');
  if (sec) {
    const first = sec.split('\n').map(l => l.trim()).find(l => l.length > 0 && !l.startsWith('-') && !l.startsWith('*'));
    if (first) return first;
  }
  const verdictBit = criteria?.verdict ? ` Verdict: ${criteria.verdict}.` : '';
  const passBit = criteria?.passCount ? ` Criteria ${criteria.passCount}/${criteria.passCount + criteria.failCount} pass.` : '';
  return `Build artifact present for ${storyId}.${verdictBit}${passBit}`;
})();
out.push(summaryLine);
out.push('');

// Findings — pull bullets from ## Shipped / ## Findings / ## Changes.
const findings = []
  .concat(extractBullets(sliceSection(text, '## Shipped'), 6))
  .concat(extractBullets(sliceSection(text, '## Findings'), 6))
  .concat(extractBullets(sliceSection(text, '## Changes'), 6))
  .concat(extractBullets(sliceSection(text, '## Files changed'), 6))
  .slice(0, 8);

if (findings.length === 0) {
  // Always emit at least one numbered item — the structural contract.
  out.push('1) Build artifact written; see 03-build.md for full detail.');
} else {
  for (let i = 0; i < findings.length; i++) {
    out.push(`${i + 1}) ${findings[i]}`);
  }
}
out.push('');

const nextStep = extractNextStep(text) || 'awaiting /qa.';
out.push(`Next step is ${nextStep.replace(/\.$/, '')}.`);

process.stdout.write(out.join('\n') + '\n');
