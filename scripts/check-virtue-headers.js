#!/usr/bin/env node
// scripts/check-virtue-headers.js — st_7fcebb44
//
// Validates Staircase Virtue headers in pipeline skill SKILL.md files.
//
// Source of truth: ~/.claude/skills/virtue-mapping.json (override with --mapping).
// Skills directory: ~/.claude/skills (override with --skills-dir).
//
// For each mapped (skill, virtue, keyword):
//   - Read <skills-dir>/<skill>/SKILL.md. If missing, log warning and continue.
//   - Find a line that, after stripping leading `#`/`*`/whitespace, ends with
//     `<Keyword>:`. That's the header line.
//   - Count non-blank lines between that header and the next header (any
//     virtue keyword in the file) or EOF. Require ≥3.
//
// Exit 0 on all-pass. Exit 1 on first failure with a precise message:
//   <skill> — missing header "<Keyword>:"
//   <skill> "<Keyword>:" has N non-blank lines (need ≥3)
//
// Tier: orchestration (no LLM).

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

function expandPath(p) {
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  if (isAbsolute(p)) return p;
  return resolve(process.cwd(), p);
}

function parseArgs(argv) {
  const out = {
    mapping: expandPath('~/.robotdojo/virtue-mapping.json'),
    skillsDir: expandPath('~/.claude/skills'),
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--mapping' && argv[i + 1]) {
      out.mapping = expandPath(argv[i + 1]); i++;
    } else if (argv[i] === '--skills-dir' && argv[i + 1]) {
      out.skillsDir = expandPath(argv[i + 1]); i++;
    }
  }
  return out;
}

// Strip leading `#`, `*`, whitespace. Returns the cleaned line for header-match.
function stripHeaderPrefix(line) {
  return line.replace(/^[\s#*]+/, '').trimEnd();
}

// All keywords across all mapped skills — used to detect "next header" boundary.
function collectAllKeywords(mapping) {
  const s = new Set();
  for (const skill of Object.keys(mapping)) {
    for (const group of mapping[skill]) {
      for (const kw of group.keywords) s.add(kw);
    }
  }
  return s;
}

function isHeaderLine(line, allKeywords) {
  const stripped = stripHeaderPrefix(line);
  if (!stripped.endsWith(':')) return null;
  const headerText = stripped.slice(0, -1).trim();
  if (allKeywords.has(headerText)) return headerText;
  return null;
}

function findHeaderAndCount(lines, keyword, allKeywords) {
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const matched = isHeaderLine(lines[i], allKeywords);
    if (matched === keyword) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return { found: false, nonBlank: 0 };
  // Count non-blank lines from headerIdx+1 until next header or EOF.
  let nonBlank = 0;
  for (let j = headerIdx + 1; j < lines.length; j++) {
    if (isHeaderLine(lines[j], allKeywords) !== null) break;
    if (lines[j].trim().length > 0) nonBlank++;
  }
  return { found: true, nonBlank };
}

function main() {
  const args = parseArgs(process.argv);
  if (!existsSync(args.mapping)) {
    process.stderr.write(`mapping not found: ${args.mapping}\n`);
    process.exit(1);
  }
  const mapping = JSON.parse(readFileSync(args.mapping, 'utf8'));
  const allKeywords = collectAllKeywords(mapping);

  for (const skill of Object.keys(mapping)) {
    const skillPath = join(args.skillsDir, skill, 'SKILL.md');
    if (!existsSync(skillPath)) {
      process.stderr.write(`warning: ${skill} SKILL.md not found at ${skillPath} — skipping\n`);
      continue;
    }
    const text = readFileSync(skillPath, 'utf8');
    const lines = text.split('\n');
    for (const group of mapping[skill]) {
      for (const keyword of group.keywords) {
        const { found, nonBlank } = findHeaderAndCount(lines, keyword, allKeywords);
        if (!found) {
          process.stderr.write(`${skill} — missing header "${keyword}:"\n`);
          process.exit(1);
        }
        if (nonBlank < 3) {
          process.stderr.write(`${skill} "${keyword}:" has ${nonBlank} non-blank lines (need ≥3)\n`);
          process.exit(1);
        }
      }
    }
  }
  process.stdout.write('ok\n');
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { findHeaderAndCount, collectAllKeywords, isHeaderLine, parseArgs };
