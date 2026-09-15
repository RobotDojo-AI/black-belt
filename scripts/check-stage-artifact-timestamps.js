#!/usr/bin/env node
/**
 * Blocks manual timestamp placeholders in live story substrate templates.
 *
 * Generated timestamps belong in scripts that own their evidence, such as
 * story-gate seal metadata or criteria-runner evidence. Stage artifacts should
 * not ask agents to hand-write dates in prose.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CHECKED_SKILLS = [
  'agents/skills/story/SKILL.md',
  'agents/skills/defect/SKILL.md',
  'agents/skills/work/SKILL.md',
  'agents/skills/framing/SKILL.md',
  'agents/skills/research/SKILL.md',
  'agents/skills/scope/SKILL.md',
  'agents/skills/plan/SKILL.md',
  'agents/skills/build/SKILL.md',
  'agents/skills/qa/SKILL.md',
  'agents/skills/close/SKILL.md',
];

const MANUAL_DATE_RE = /^\s*Date:\s*\{[^}]*\}\s*$/m;

const findings = [];

for (const relPath of CHECKED_SKILLS) {
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) continue;
  const source = readFileSync(abs, 'utf8');
  const match = source.match(MANUAL_DATE_RE);
  if (match) {
    findings.push(`${relPath}: manual timestamp placeholder "${match[0].trim()}"`);
  }
}

if (findings.length) {
  process.stderr.write('[check-stage-artifact-timestamps] FAIL\n');
  for (const finding of findings) process.stderr.write(`  - ${finding}\n`);
  process.exit(1);
}

process.stdout.write('[check-stage-artifact-timestamps] ok — stage artifacts do not request manual timestamps\n');
