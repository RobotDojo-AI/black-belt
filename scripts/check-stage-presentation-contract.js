#!/usr/bin/env node
// Enforces the owner-facing stage approval prompt contract.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const STAGE_SKILLS = ['research', 'scope', 'plan', 'build', 'qa'];
const MAX_OWNER_BLOCK_LINES = 18;
const MAX_APPROVAL_ITEMS = 4;
const TECHNICAL_LEAD_RE = /\b(technical verification|verification|tests?|criteria|command|node\b|npm\b|git\b|sha256|hash|exit code|stdout|stderr|diff|files changed|implementation)\b/i;
const TECHNICAL_VALUE_RE = /(`|\/|\.js\b|\.md\b|\b(node|npm|git|curl|bash|script|test|criteria|checker|hash|diff|file|implementation|artifact|seal)\b)/i;
const STATUS_TABLE_RE = /\[\s*(PASS|FAIL|SKIP)\s*\]/i;
const PREFERRED_NUMBER_RE = /^\d+\)\s+\S/;
const PERIOD_NUMBER_RE = /^\d+\.\s+\S/;
// st_862d73d1 AC5/AC7 — alpha child items use `a)` (paren), never `a.` (period)
// and never letter-first parents like `a1`/`a2`. The house numbering verdict is
// numeric parent `1)` + alpha child `a)`.
const PREFERRED_ALPHA_CHILD_RE = /^[a-z]\)\s+\S/;
const PERIOD_ALPHA_CHILD_RE = /^[a-z]\.\s+\S/;
const LETTER_FIRST_PARENT_RE = /^[a-z]\d+\b/;
const DASH_BULLET_RE = /^[-*]\s+\S/;

function fail(message, details = []) {
  const lines = [`FAIL stage-presentation-contract — ${message}`];
  for (const detail of details) lines.push(`- ${detail}`);
  return lines.join('\n');
}

function meaningfulLines(text) {
  return text
    .split(/\r?\n/)
    .map((raw, index) => ({ raw, line: raw.trim(), number: index + 1 }))
    .filter(({ line }) => line && !/^```/.test(line));
}

export function checkPromptText(text, label = 'prompt') {
  const errors = [];
  const lines = meaningfulLines(text);
  if (lines.length === 0) {
    return { ok: false, errors: [`${label}: empty prompt`] };
  }

  const first = lines[0];
  if (TECHNICAL_LEAD_RE.test(first.line)) {
    errors.push(`${label}:${first.number}: technical verification leads the owner-facing block`);
  }
  if (TECHNICAL_VALUE_RE.test(first.line)) {
    errors.push(`${label}:${first.number}: lead summary must not contain paths, commands, test words, or implementation terms`);
  }

  if (lines.length > MAX_OWNER_BLOCK_LINES) {
    errors.push(`${label}: owner-facing block has ${lines.length} meaningful lines; max is ${MAX_OWNER_BLOCK_LINES}`);
  }

  if (lines.some(({ line }) => STATUS_TABLE_RE.test(line))) {
    errors.push(`${label}: owner-facing prose must not use [PASS]/[FAIL]/[SKIP] status-table styling`);
  }

  const numberedLines = lines.filter(({ line }) => PREFERRED_NUMBER_RE.test(line));
  const periodNumberedLines = lines.filter(({ line }) => PERIOD_NUMBER_RE.test(line));
  const periodAlphaChildLines = lines.filter(({ line }) => PERIOD_ALPHA_CHILD_RE.test(line));
  const letterFirstParentLines = lines.filter(({ line }) => LETTER_FIRST_PARENT_RE.test(line));
  const dashBulletLines = lines.filter(({ line }) => DASH_BULLET_RE.test(line));
  if (dashBulletLines.length) {
    for (const { number } of dashBulletLines) {
      errors.push(`${label}:${number}: use worked-example numbering, not dash bullets`);
    }
  }
  if (periodNumberedLines.length) {
    for (const { number } of periodNumberedLines) {
      errors.push(`${label}:${number}: use "1)" numbering, not "1." numbering`);
    }
  }
  // st_862d73d1 AC5/AC7 — alpha children use `a)`, never `a.`; parents are never
  // letter-first (a1/a2).
  if (periodAlphaChildLines.length) {
    for (const { number } of periodAlphaChildLines) {
      errors.push(`${label}:${number}: use "a)" child numbering, not "a." numbering`);
    }
  }
  if (letterFirstParentLines.length) {
    for (const { number } of letterFirstParentLines) {
      errors.push(`${label}:${number}: use numeric-parent / alpha-child "1)" then "a)", never letter-first "a1"/"a2"`);
    }
  }
  if (numberedLines.length > MAX_APPROVAL_ITEMS) {
    errors.push(`${label}: numbered owner items has ${numberedLines.length} items; max is ${MAX_APPROVAL_ITEMS}`);
  }

  const nextStep = lines.find(({ line }) => /^next step\b/i.test(line));
  if (!nextStep) {
    errors.push(`${label}: missing final "Next step..." line`);
  } else if (nextStep !== lines[lines.length - 1]) {
    errors.push(`${label}:${nextStep.number}: "Next step..." must be the final line`);
  }

  const hasConclusion = lines.some(({ line }, index) => index < lines.length - 1 && /\b(approve|approval|decision|conclusion|ready|blocked|close|move to)\b/i.test(line));
  if (!hasConclusion) {
    errors.push(`${label}: missing conclusion or decision line before next step`);
  }

  return { ok: errors.length === 0, errors };
}

function checkContains(text, path, needle, errors) {
  if (!text.includes(needle)) errors.push(`${path}: missing "${needle}"`);
}

export function checkRepositoryContract(root = REPO_ROOT) {
  const errors = [];
  const formattingPath = 'config/agent-voice/formatting/coding-agent.md';
  const formatting = readFileSync(join(root, formattingPath), 'utf8');
  checkContains(formatting, formattingPath, '## Stage Approval Prompts', errors);
  checkContains(formatting, formattingPath, 'Max 18 meaningful lines.', errors);
  checkContains(formatting, formattingPath, 'Use numbered items as `1)`', errors);
  checkContains(formatting, formattingPath, 'End with a conclusion or decision line, then a next-step line.', errors);
  checkContains(formatting, formattingPath, 'Do not use `[PASS]` / `[FAIL]` status-table styling in owner-facing prose.', errors);
  checkContains(formatting, formattingPath, 'Technical proof belongs in the artifact, not in the lead summary.', errors);

  for (const skill of STAGE_SKILLS) {
    const skillPath = `agents/skills/${skill}/SKILL.md`;
    const text = readFileSync(join(root, skillPath), 'utf8');
    // st_862d73d1 AC5 — reconciled to the SKILLs' actual contract text. The
    // SKILLs say "user-facing block" (not "owner-facing block"); the check was
    // asserting a string that never existed, which is why this gate was
    // orphaned (it would have blocked every seal). Wired now → strings match.
    checkContains(text, skillPath, 'draft owner-facing approval prompt', errors);
    checkContains(text, skillPath, 'Bunshin must audit both the artifact and owner-facing presentation.', errors);
    checkContains(text, skillPath, 'compact `config/agent-voice/formatting/coding-agent.md` worked-example shape', errors);
    checkContains(text, skillPath, 'max 18 meaningful lines, plain English, and owner-value first', errors);
    checkContains(text, skillPath, 'Technical verification must not lead the user-facing block.', errors);
  }

  return { ok: errors.length === 0, errors };
}

function parseArgs(argv) {
  const args = { file: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') {
      args.file = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(fail(err.message));
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    console.log('Usage: node scripts/check-stage-presentation-contract.js [--file owner-facing-prompt.md]');
    return;
  }

  const checks = [checkRepositoryContract()];
  if (args.file) {
    const file = resolve(args.file);
    if (!existsSync(file)) {
      console.error(fail(`file not found: ${file}`));
      process.exitCode = 2;
      return;
    }
    checks.push(checkPromptText(readFileSync(file, 'utf8'), file));
  }

  const errors = checks.flatMap((check) => check.errors);
  if (errors.length) {
    console.error(fail(`${errors.length} violation${errors.length === 1 ? '' : 's'}`, errors));
    process.exitCode = 1;
    return;
  }

  console.log(`ok — stage presentation contract (${args.file ? 'repo + prompt' : 'repo'})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
