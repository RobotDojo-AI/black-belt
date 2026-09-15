#!/usr/bin/env node
// scripts/smoke-test-skill.js — st_7fcebb44
//
// Per-rung structural smoke test for a single skill SKILL.md file.
//
// Validates:
//   1) <name>/SKILL.md exists under ~/.claude/skills/<name>/
//   2) Every `<!-- include: -->` marker in the file resolves via
//      resolveMarkers() (path exists, sha256 matches, no circular include)
//   3) Expanded content carries ≥4 top-level `## ` headings
//
// Exit 0 on success; exit 1 on first failure with `<skill>: <reason>`.
//
// This is a proxy — it does NOT prove the skill behaves correctly when
// Claude Code runs it. It catches structural corruption introduced by
// substrate cleanup (dedup wiped a section, marker hash drifted, etc.).
//
// Tier: orchestration (no LLM).

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { resolveMarkers } from '../../.claude/lib/resolve-markers.js';

const SKILLS_ROOT = join(homedir(), '.claude', 'skills');
const INCLUDE_RE = /<!--\s*include:\s*(\S+)\s+sha256=([0-9a-f]{64})\s*-->/g;

function fail(skill, reason) {
  process.stderr.write(`${skill}: ${reason}\n`);
  process.exit(1);
}

function main() {
  const skill = process.argv[2];
  if (!skill) {
    process.stderr.write('usage: smoke-test-skill.js <skill-name>\n');
    process.exit(1);
  }
  const skillPath = join(SKILLS_ROOT, skill, 'SKILL.md');
  if (!existsSync(skillPath)) {
    fail(skill, `SKILL.md not found at ${skillPath}`);
  }
  const text = readFileSync(skillPath, 'utf8');

  // Resolve markers — this enforces existence + sha256 + no cycle.
  let expanded;
  try {
    expanded = resolveMarkers(text, dirname(skillPath));
  } catch (e) {
    fail(skill, `resolver failed — ${e.message}`);
  }

  // Validate at least 4 top-level `## ` headings.
  const headings = expanded.split('\n').filter((l) => /^##\s+\S/.test(l));
  if (headings.length < 4) {
    fail(skill, `expanded content has ${headings.length} \`## \` headings (need ≥4)`);
  }

  // Defensive cross-check: every include marker in the original file was
  // satisfied by the resolver. resolveMarkers would have thrown on any
  // mismatch, but we re-scan to confirm zero markers remain in the expanded
  // output (which would indicate a parsing bug).
  const remaining = expanded.match(INCLUDE_RE);
  if (remaining && remaining.length > 0) {
    fail(skill, `${remaining.length} include marker(s) survived expansion`);
  }

  process.stdout.write(`${skill}: ok\n`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main };
