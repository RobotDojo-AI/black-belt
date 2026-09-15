#!/usr/bin/env node
/**
 * render-scope.js — deterministic scope presentation renderer.
 *
 * Usage:
 *   node scripts/render-scope.js <path-to-00-scope.md>
 *
 * Emits the canonical AC-before-OOS presentation per config/formatting/claude-code.md:
 *   ## Acceptance criteria
 *   1) <text>
 *   2) <text>
 *   ...
 *
 *   ## Out of scope
 *   1) <text>
 *   ...
 *
 *   Sign-off needed item by item, or "all N ok / M ok" to advance.
 *
 * AC-39 (st_0c491456): pipeline skills presenting scope should render through
 * this helper so the shape matches the formatting contract without depending
 * on model memory. The number of emitted ACs MUST equal the source count.
 */

import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const scopePath = args[0];

if (!scopePath) {
  process.stderr.write('Usage: render-scope.js <path-to-00-scope.md>\n');
  process.exit(1);
}
if (!existsSync(scopePath)) {
  process.stderr.write(`render-scope: file not found: ${scopePath}\n`);
  process.exit(1);
}

const text = readFileSync(scopePath, 'utf8');

// Slice "## Heading" up to the next "## " or EOF.
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

// Extract numbered items from a section. Captures multi-line item text
// (any continuation lines that aren't a new numbered item or a blank gap
// followed by another item) and joins them with single spaces.
//
// Source items are written as `N.` or `N)`; output normalizes to `N)`.
function extractNumberedItems(section) {
  if (!section) return [];
  const lines = section.split('\n');
  const items = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^(\d+)[.)]\s+(.*)$/);
    // Indented lettered child: ` a) text` or ` a. text`. Must be indented so a
    // wrapped parent sentence that happens to start with a letter+period (a
    // genuine continuation) is not mistaken for a child — leading \s+ required.
    const childMatch = line.match(/^\s+([a-z])[.)]\s+(.*)$/);
    if (m) {
      if (current) items.push(current);
      current = { number: Number(m[1]), text: m[2].trim(), children: [] };
    } else if (current && childMatch) {
      // lettered child of the current parent — kept as structure, never
      // concatenated into the parent text and never counted as a parent.
      current.children.push({ letter: childMatch[1], text: childMatch[2].trim() });
    } else if (current && line.trim() !== '' && !line.startsWith('#')) {
      // continuation of the current item — append with one space
      current.text += ' ' + line.trim();
    } else if (line.trim() === '') {
      // blank line ends the current item if a new one starts next; just stash.
      if (current) {
        items.push(current);
        current = null;
      }
    }
  }
  if (current) items.push(current);
  // Dedup by number, last write wins (handles a malformed section gracefully
  // but in practice numbers are unique).
  const byNum = new Map();
  for (const it of items) byNum.set(it.number, it);
  return [...byNum.values()].sort((a, b) => a.number - b.number);
}

const acSection = sliceSection(text, '## Acceptance criteria')
  || sliceSection(text, '## Acceptance Criteria');
const oosSection = sliceSection(text, '## Out of scope')
  || sliceSection(text, '## Out of Scope');

if (!acSection) {
  process.stderr.write('render-scope: source file has no "## Acceptance criteria" section.\n');
  process.exit(1);
}

const acs = extractNumberedItems(acSection);
const oos = extractNumberedItems(oosSection || '');

if (acs.length === 0) {
  process.stderr.write('render-scope: zero numbered ACs found under "## Acceptance criteria".\n');
  process.exit(1);
}

const out = [];
out.push('## Acceptance criteria');
out.push('');
for (const ac of acs) {
  out.push(`${ac.number}) ${ac.text}`);
  // Lettered children render 4-space-indented under their parent, normalized
  // to `)` per config/formatting/claude-code.md. Children are never numbered.
  for (const child of ac.children || []) {
    out.push(`    ${child.letter}) ${child.text}`);
  }
}
out.push('');

if (oos.length > 0) {
  out.push('## Out of scope');
  out.push('');
  // OOS items render as `- ` dashes — only ACs need point-by-point sign-off,
  // OOS items are context. Keeping them as `N)` would double-count under the
  // AC-39 verifier (`grep -c "^[0-9]*)"` which can't distinguish AC from OOS).
  for (const it of oos) {
    out.push(`- ${it.text}`);
  }
  out.push('');
}

const acCount = acs.length;
const oosCount = oos.length;
out.push(`Sign-off needed item by item, or "all ${acCount} ok / ${oosCount} ok" to advance.`);

process.stdout.write(out.join('\n') + '\n');
