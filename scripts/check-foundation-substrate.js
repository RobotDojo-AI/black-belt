#!/usr/bin/env node
/**
 * check-foundation-substrate.js
 *
 * Focused Day 0 substrate gate. This is not a style linter; it catches the
 * specific launch-blocking drift that broke trust:
 *   - deleted autonomous substrate files returning
 *   - canonical surfaces becoming autonomous again
 *   - portable docs/skills hard-coding the first user
 *   - arbitrary Codex-visible subagent names being treated as Robot Dojo agents
 *   - D1 appearing unblocked before the foundation story closes
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const INTELLIGENCE_TIER = 'extraction';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { repoRoot: DEFAULT_ROOT };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--repo') args.repoRoot = resolve(argv[++i]);
  }
  return args;
}

const { repoRoot } = parseArgs(process.argv);
const errors = [];

const deletedPaths = [
  'apps/static/launch-agents/com.robotdojo.compound-kanban.plist.template',
  'apps/static/launch-agents/com.robotdojo.compound-user.plist.template',
  'config/compound-doc-configs',
  'config/rubrics',
  'lib/canonical-regen-loop.js',
  'lib/memory-router.js',
  'scripts/check-missed-triggers.js',
  'scripts/check-trigger-config.js',
  'scripts/compound-doc.js',
  'scripts/intent-to-rubric.js',
  'scripts/pre-push-compound.sh',
  'scripts/trigger-dispatcher.js',
  'tests/compound-script-routing.test.js',
  'tests/intent-to-rubric.test.js',
];

for (const relPath of deletedPaths) {
  if (existsSync(join(repoRoot, relPath))) {
    errors.push(`deleted substrate path exists: ${relPath}`);
  }
}

function readJson(relPath) {
  try {
    return JSON.parse(readFileSync(join(repoRoot, relPath), 'utf8'));
  } catch (err) {
    errors.push(`cannot read ${relPath}: ${err.message}`);
    return null;
  }
}

const registry = readJson('architecture/surfaces.json');
if (registry) {
  for (const [idx, surface] of (registry.surfaces || []).entries()) {
    const label = surface.path || `surfaces[${idx}]`;
    if (surface.class !== 'human-authored') {
      errors.push(`canonical surface is not human-authored: ${label} (${surface.class})`);
    }
    if (surface.owner_script !== null) {
      errors.push(`canonical surface has owner_script: ${label}`);
    }
    if (Array.isArray(surface.trigger_config?.events) && surface.trigger_config.events.length > 0) {
      errors.push(`canonical surface has trigger events: ${label}`);
    }
    if (Object.prototype.hasOwnProperty.call(surface, 'synthesizer')) {
      errors.push(`canonical surface has retired synthesizer field: ${label}`);
    }
  }
}

function walk(relRoot) {
  const absRoot = join(repoRoot, relRoot);
  if (!existsSync(absRoot)) return [];
  const out = [];
  const stack = [absRoot];
  while (stack.length) {
    const abs = stack.pop();
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) stack.push(join(abs, name));
    } else if (st.isFile()) {
      out.push(relative(repoRoot, abs));
    }
  }
  return out.sort();
}

const portableDocs = [
  'CLAUDE.md',
  'architecture/product.md',
  'architecture/architecture.md',
  'architecture/structure.md',
  'agents/agents.md',
  ...walk('agents/personas').filter((p) => p.endsWith('.md')),
  'agents/build-conventions.md',
  'agents/default-quality.md',
  ...walk('agents/skills').filter((p) => p.endsWith('.md')),
];

for (const relPath of portableDocs) {
  const abs = join(repoRoot, relPath);
  if (!existsSync(abs)) continue;
  let text = readFileSync(abs, 'utf8');
  const firstUserName = ['A', 'd', 'a', 'm'].join('');
  if (new RegExp(`\\b${firstUserName}\\b`).test(text)) {
    errors.push(`portable surface hard-codes first user: ${relPath}`);
  }
  if (/\b(Meitner|Ramanujan|Boyle|Descartes)\b/.test(text)) {
    errors.push(`portable surface names unapproved subagent transport identity: ${relPath}`);
  }
}

const activeTextFiles = [
  ...portableDocs,
  'config/registry-schema.json',
  'scripts/check-registry-schema.js',
  'scripts/claude.js',
  'scripts/generate-ontology.js',
  'scripts/pre-commit.sh',
  'scripts/seed-canonical-genesis.js',
  'scripts/generate-identity.js',
  'lib/canonical-write.js',
];

const stalePatterns = [
  /\bsynthesizer\b/i,
  /\bquality-judge\b/i,
  /\bcompound-doc\b/i,
  /\btrigger-dispatcher\b/i,
  /\bcanonical-regen-loop\b/i,
  /\bmemory-router\b/i,
  /\bintent-to-rubric\b/i,
  /\bpre-push-compound\b/i,
  /\bcheck-trigger-config\b/i,
  /\bcheck-missed-triggers\b/i,
];

for (const relPath of activeTextFiles) {
  const abs = join(repoRoot, relPath);
  if (!existsSync(abs)) continue;
  let text = readFileSync(abs, 'utf8');
  for (const pattern of stalePatterns) {
    if (pattern.test(text)) {
      errors.push(`stale active substrate reference ${pattern} in ${relPath}`);
    }
  }
}

const agents = existsSync(join(repoRoot, 'agents/agents.md'))
  ? readFileSync(join(repoRoot, 'agents/agents.md'), 'utf8')
  : '';
if (!/Miyagi is the main agent/.test(agents)) {
  errors.push('agents/agents.md does not declare Miyagi as the main agent');
}
if (!/Codex transport rule/.test(agents)) {
  errors.push('agents/agents.md does not document the Codex transport rule');
}
if (!/not Robot Dojo specialist execution/.test(agents)) {
  errors.push('agents/agents.md does not reject arbitrary subagent identities');
}
if (
  !/Bunshin QC rule/.test(agents)
  || !/for research, scope, plan, build, and QA, run Bunshin before presenting the artifact/i.test(agents)
  || !/Close does not require Bunshin when it only wraps already-approved QA/i.test(agents)
  || !/Miyagi self-audit (can be useful, but it )?is not Bunshin approval/.test(agents)
) {
  errors.push('agents/agents.md does not make Bunshin mandatory QC with honest transport handling');
}

const requiredBunshinSkills = ['research', 'scope', 'plan', 'build', 'qa'];
for (const skill of requiredBunshinSkills) {
  const relPath = `agents/skills/${skill}/SKILL.md`;
  const abs = join(repoRoot, relPath);
  if (!existsSync(abs)) {
    errors.push(`missing required stage skill: ${relPath}`);
    continue;
  }
  const text = readFileSync(abs, 'utf8');
  if (!/## Bunshin QC/.test(text)) {
    errors.push(`stage skill missing Bunshin QC section: ${relPath}`);
  }
  if (!/Required before presenting or sealing this stage artifact/.test(text)) {
    errors.push(`stage skill does not require Bunshin before presentation: ${relPath}`);
  }
  if (!/Miyagi self-audit is not Bunshin approval/.test(text)) {
    errors.push(`stage skill does not reject Miyagi-as-Bunshin: ${relPath}`);
  }
}

const framingSkill = existsSync(join(repoRoot, 'agents/skills/framing/SKILL.md'))
  ? readFileSync(join(repoRoot, 'agents/skills/framing/SKILL.md'), 'utf8')
  : '';
if (/## Bunshin QC/.test(framingSkill)) {
  errors.push('framing skill must not require Bunshin QC');
}

const closeSkill = existsSync(join(repoRoot, 'agents/skills/close/SKILL.md'))
  ? readFileSync(join(repoRoot, 'agents/skills/close/SKILL.md'), 'utf8')
  : '';
if (/## Bunshin QC/.test(closeSkill) || /Required before presenting or sealing this stage artifact/.test(closeSkill)) {
  errors.push('close skill must not require Bunshin for ordinary close');
}
if (!/Close QC/.test(closeSkill) || !/Bunshin is optional for ordinary close/.test(closeSkill)) {
  errors.push('close skill does not document optional Bunshin close rule');
}

const bunshinPersona = existsSync(join(repoRoot, 'agents/personas/Bunshin.md'))
  ? readFileSync(join(repoRoot, 'agents/personas/Bunshin.md'), 'utf8')
  : '';
if (!/mandatory stage QC auditor/.test(bunshinPersona) || /optional artifact auditor/i.test(bunshinPersona)) {
  errors.push('Bunshin persona does not describe mandatory stage QC');
}

if (errors.length > 0) {
  process.stderr.write(`[check-foundation-substrate] FAIL — ${errors.length} violation(s):\n`);
  for (const err of errors) process.stderr.write(`  - ${err}\n`);
  process.exit(1);
}

process.stdout.write('[check-foundation-substrate] ok — foundation substrate invariants hold\n');
