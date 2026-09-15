#!/usr/bin/env node
// scripts/check-agent-trust-filter.js -- st_1103b91f deterministic gate.
//
// Verifies the compact trust filter lives in the canonical Robot Dojo surfaces
// without moving the full low-trust taxonomy into the always-loaded web voice
// canon.

import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVoiceCanonBlock } from '../lib/chat/system-prompt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const ALL_CHECKS = ['behavior', 'decision-boundary', 'placement', 'tools', 'web-budget'];
const CHECKS = new Set(ALL_CHECKS);

const TRUST_NEEDLES = [
  'Trust filter',
  'substantive advice',
  'evidence',
  'constraints',
  'self-refutation',
  'action',
  'ownership',
];

const DECISION_NEEDLES = ['owner decision', 'Miyagi recommendation', 'undecided'];
const TOOL_SURFACE_NEEDLES = ['skill', 'persona', 'user-voice file', 'channel voice rule', 'stage gate'];
const WEB_VOICE_BUDGET = 9200;
const BASE_BUDGET = 4800;
const CHAT_APP_BUDGET = 1300;

const TAXONOMY_LABELS = [
  'crumbling suggestions',
  'over-optimism',
  'menu-dumping',
  'invented premises',
  'not listening',
  'vacuous filler',
  'deflecting blame',
  "ignoring the user's own tools",
  'LLM-recursion',
  'armchair suggestions',
  'manufacturing a decision',
];

function read(relPath) {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

function size(relPath) {
  return statSync(resolve(REPO_ROOT, relPath)).size;
}

function extractMarkdownSection(markdown, heading) {
  const lines = String(markdown || '').split('\n');
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return '';
  const level = (heading.match(/^#+/) || ['#'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function parseRequestedChecks(argv) {
  const out = [];
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--check') {
      throw new Error(`unknown argument: ${arg}`);
    }
    const name = argv[++i];
    if (!name) throw new Error('--check requires a value');
    if (!CHECKS.has(name)) throw new Error(`unknown --check value: ${name}`);
    out.push(name);
  }
  return out.length ? out : ALL_CHECKS;
}

function assertIncludes(haystack, needles, label, violations) {
  for (const needle of needles) {
    if (!haystack.includes(needle)) {
      violations.push(`${label}: missing ${JSON.stringify(needle)}`);
    }
  }
}

function assertAbsent(haystack, needles, label, violations) {
  for (const needle of needles) {
    if (haystack.includes(needle)) {
      violations.push(`${label}: must not include full taxonomy label ${JSON.stringify(needle)}`);
    }
  }
}

function loadSurfaces() {
  return JSON.parse(read('architecture/surfaces.json')).surfaces || [];
}

function assertSurfaceBudget(relPath, max, violations) {
  const entry = loadSurfaces().find((s) => s.path === relPath);
  if (!entry) {
    violations.push(`architecture/surfaces.json: missing ${relPath}`);
    return;
  }
  if (entry.class !== 'human-authored') {
    violations.push(`${relPath}: surface class must be human-authored`);
  }
  if (entry.max_chars > max) {
    violations.push(`${relPath}: max_chars ${entry.max_chars} exceeds ${max}`);
  }
  const actual = size(relPath);
  if (actual > entry.max_chars) {
    violations.push(`${relPath}: ${actual} chars exceeds registered max ${entry.max_chars}`);
  }
}

function main() {
  const violations = [];
  let requested;
  try {
    requested = parseRequestedChecks(process.argv);
  } catch (err) {
    process.stderr.write(`[check-agent-trust-filter] ${err.message}\n`);
    process.exit(2);
  }

  const base = read('config/agent-voice/voice.md');
  const chatApp = read('config/agent-voice/formatting/web.md');
  const miyagi = read('agents/personas/Miyagi.md');
  const miyagiIdentity = extractMarkdownSection(miyagi, '### Identity');

  for (const check of requested) {
    if (check === 'behavior') {
      assertIncludes(base, TRUST_NEEDLES, 'config/agent-voice/voice.md', violations);
      assertIncludes(miyagiIdentity, ['trust filter', 'substantive advice'], 'Miyagi Identity', violations);
    }

    if (check === 'decision-boundary') {
      assertIncludes(miyagiIdentity, DECISION_NEEDLES, 'Miyagi Identity', violations);
      for (const rel of [
        'agents/dist/AGENTS.md',
        'agents/dist/claude.md',
        'agents/dist/claude-agents/Miyagi.md',
      ]) {
        assertIncludes(read(rel), DECISION_NEEDLES, rel, violations);
      }
    }

    if (check === 'placement') {
      assertIncludes(base, TRUST_NEEDLES, 'shared voice', violations);
      assertIncludes(miyagiIdentity, DECISION_NEEDLES, 'Miyagi web-loaded Identity', violations);
      for (const rel of [
        'agents/skills/research/SKILL.md',
        'agents/skills/scope/SKILL.md',
        'agents/skills/plan/SKILL.md',
        'agents/skills/build/SKILL.md',
        'agents/skills/qa/SKILL.md',
      ]) {
        assertIncludes(read(rel), ['Bunshin QC'], rel, violations);
      }
      assertIncludes(read('agents/personas/Bunshin.md'), ['mandatory stage QC auditor'], 'Bunshin persona', violations);
    }

    if (check === 'tools') {
      assertIncludes(miyagiIdentity, TOOL_SURFACE_NEEDLES, 'Miyagi Identity', violations);
    }

    if (check === 'web-budget') {
      assertSurfaceBudget('config/agent-voice/voice.md', BASE_BUDGET, violations);
      assertSurfaceBudget('config/agent-voice/formatting/web.md', CHAT_APP_BUDGET, violations);
      const canon = buildVoiceCanonBlock();
      if (canon.length > WEB_VOICE_BUDGET) {
        violations.push(`web voice canon: ${canon.length} chars exceeds ${WEB_VOICE_BUDGET}`);
      }
      assertIncludes(canon, TRUST_NEEDLES, 'web voice canon', violations);
      assertAbsent(canon, TAXONOMY_LABELS, 'web voice canon', violations);
      assertAbsent(`${base}\n${chatApp}\n${miyagiIdentity}`, TAXONOMY_LABELS, 'web-loaded voice sources', violations);
    }
  }

  if (violations.length) {
    process.stderr.write(`[check-agent-trust-filter] FAIL - ${violations.length} violation(s):\n`);
    for (const violation of violations) process.stderr.write(`  ${violation}\n`);
    process.exit(1);
  }

  process.stdout.write(`[check-agent-trust-filter] ok - ${requested.join(', ')}\n`);
}

main();
