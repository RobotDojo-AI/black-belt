#!/usr/bin/env node
// scripts/check-print-voice.js — st_7fcebb44
//
// Scans markdown files for voice violations inside print-to-owner blocks.
//
// Scope: only content between `<!-- print-to-owner:start -->` and
// `<!-- print-to-owner:end -->` markers is examined. Anything outside that
// range is ignored — this script is intentionally narrow.
//
// Banned patterns (matched against scoped content):
//   - /\b(simply|obviously|easily|just|really|very)\b/gi  (padding)
//   - /Say yes or run \/\w+/g                              (agent-meta)
//   - /^VERDICT:\s*$/gm                                    (verdict filler line)
//   - /\b(is|are|was|were|been|being)\s+\w+ed\b/g          (basic passive)
//
// Suppression: if the *previous source line* contains `<!-- voice-allow: ... -->`,
// suppress ONE match on the next line. Inline overrides for legitimate edge cases.
//
// Args: paths to scan. Directories are recursively walked for *.md files.
// Exit 0 on clean. Exit 1 on first violation: `<file>:<line> — pattern matched: <text>`.
//
// Tier: orchestration (no LLM).

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, extname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const START_MARK = '<!-- print-to-owner:start -->';
const END_MARK = '<!-- print-to-owner:end -->';
const ALLOW_RE = /<!--\s*voice-allow:[^>]*-->/;

// Order matters only for the first-violation report — we scan patterns in
// declared order on each line.
const PATTERNS = [
  { name: 'padding', re: /\b(simply|obviously|easily|just|really|very)\b/gi },
  { name: 'agent-meta', re: /Say yes or run \/\w+/g },
  { name: 'verdict-filler', re: /^VERDICT:\s*$/gm },
  { name: 'passive', re: /\b(is|are|was|were|been|being)\s+\w+ed\b/g },
];

function expandPath(p) {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (isAbsolute(p)) return p;
  return resolve(process.cwd(), p);
}

function walk(target, acc) {
  // WHY: tolerate broken symlinks — substrate trees carry stale links to
  // long-gone targets (e.g., ~/.claude/skills/qa/qa → /Users/miyagi/robotdojo/agents/qa).
  // A dead link should not crash the voice check.
  let s;
  try { s = statSync(target); } catch { return; }
  if (s.isFile()) {
    if (extname(target) === '.md') acc.push(target);
    return;
  }
  if (s.isDirectory()) {
    for (const entry of readdirSync(target)) {
      walk(join(target, entry), acc);
    }
  }
}

// Returns an array of {startLine, endLine} (1-based, inclusive) for the lines
// *between* markers — markers themselves excluded.
function findScopedRanges(lines) {
  const ranges = [];
  let inside = false;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!inside && lines[i].includes(START_MARK)) {
      inside = true;
      startIdx = i + 1; // first content line is the line after the start marker
    } else if (inside && lines[i].includes(END_MARK)) {
      ranges.push({ start: startIdx, endExclusive: i }); // i is the end-marker line; exclude it
      inside = false;
      startIdx = -1;
    }
  }
  return ranges;
}

function scanFile(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const ranges = findScopedRanges(lines);
  if (ranges.length === 0) return null;
  for (const r of ranges) {
    for (let i = r.start; i < r.endExclusive; i++) {
      const line = lines[i];
      // WHY: skip the voice-allow comment itself — it's metadata, not prose.
      // Without this, "simply" inside `<!-- voice-allow: simply -->` would match.
      if (ALLOW_RE.test(line)) continue;
      // Suppression check: previous *source* line carries the allow marker.
      const prev = i > 0 ? lines[i - 1] : '';
      let suppressionsAvailable = ALLOW_RE.test(prev) ? 1 : 0;
      for (const pat of PATTERNS) {
        // Re-create regex per scan since /g state carries lastIndex.
        const re = new RegExp(pat.re.source, pat.re.flags);
        const m = re.exec(line);
        if (!m) continue;
        if (suppressionsAvailable > 0) {
          suppressionsAvailable -= 1;
          continue;
        }
        return {
          file,
          line: i + 1, // 1-based
          text: m[0],
          pattern: pat.name,
        };
      }
    }
  }
  return null;
}

function main() {
  const rawArgs = process.argv.slice(2);

  // --files support: if --files is present, treat subsequent args as an
  // explicit list of files to scan (no directory walk). Only .md files in
  // the list are checked. If the list is empty, exit clean — no staged .md
  // files relevant to this gate.
  const filesIdx = rawArgs.indexOf('--files');
  let files = [];

  if (filesIdx !== -1) {
    const explicitFiles = rawArgs.slice(filesIdx + 1).filter(a => !a.startsWith('--'));
    if (explicitFiles.length === 0) {
      process.stdout.write('ok\n');
      process.exit(0);
    }
    for (const a of explicitFiles) {
      const p = expandPath(a);
      if (!existsSync(p)) continue; // staged file may have been deleted; skip
      if (extname(p) === '.md') files.push(p);
    }
    // None of the staged files were .md — nothing to scan.
    if (files.length === 0) {
      process.stdout.write('ok\n');
      process.exit(0);
    }
  } else {
    if (rawArgs.length === 0) {
      process.stderr.write('usage: check-print-voice.js <file-or-dir>...\n');
      process.exit(1);
    }
    for (const a of rawArgs) {
      const p = expandPath(a);
      if (!existsSync(p)) {
        process.stderr.write(`path not found: ${p}\n`);
        process.exit(1);
      }
      walk(p, files);
    }
  }

  for (const f of files) {
    const v = scanFile(f);
    if (v) {
      process.stderr.write(`${v.file}:${v.line} — pattern matched: ${v.text}\n`);
      process.exit(1);
    }
  }
  process.stdout.write('ok\n');
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { scanFile, findScopedRanges, PATTERNS };
