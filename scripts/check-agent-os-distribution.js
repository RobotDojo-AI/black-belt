#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import {
  AGENT_NAMES,
  LEGACY_AGENT_RULES,
  REQUIRED_SKILLS,
  activeTextFiles,
  failOrPass,
  fileExists,
  parseArgs,
  readText,
  requirePaths,
  requireTrackedAbsent,
  scanLegacyReferences,
} from './check-final-structure-lib.js';

const { repoRoot } = parseArgs();
const errors = [];

requirePaths(repoRoot, [
  'agents/agents.md',
  'agents/personas',
  'agents/skills',
  'agents/default-quality.md',
  'agents/build-conventions.md',
  'agents/.gitignore',
  'scripts/generate-identity.js',
  'scripts/check-agent-os.js',
  'scripts/check-identity-dist-fresh.js',
  'scripts/install-skills.sh',
  'lib/agent-personas.js',
], errors);

for (const name of AGENT_NAMES) {
  const relPath = `agents/personas/${name}.md`;
  if (!fileExists(repoRoot, relPath)) errors.push(`missing persona ${relPath}`);
}

for (const name of REQUIRED_SKILLS) {
  const relPath = `agents/skills/${name}/SKILL.md`;
  if (!fileExists(repoRoot, relPath)) errors.push(`missing skill ${relPath}`);
}

if (fileExists(repoRoot, 'agents/.gitignore')) {
  const ignore = readText(repoRoot, 'agents/.gitignore');
  if (!/^dist\/?$/m.test(ignore)) {
    errors.push('agents/.gitignore must ignore generated agents/dist/');
  }
}

if (fileExists(repoRoot, 'agents/agents.md')) {
  const roster = readText(repoRoot, 'agents/agents.md');
  for (const name of AGENT_NAMES) {
    if (!new RegExp(`\\b${name}\\b`).test(roster)) {
      errors.push(`agents/agents.md does not name ${name}`);
    }
  }
  if (!/Personas are cognitive styles\. Skills are checklists\./.test(roster)) {
    errors.push('agents/agents.md must preserve the personas-vs-skills contract');
  }
}

const expectedNewPathRefs = [
  ['scripts/generate-identity.js', /agents\/roster\.md|AGENTS_ROOT/],
  ['scripts/generate-identity.js', /agents\/personas|AGENT_PERSONAS_DIR|readAllPersonas/],
  ['scripts/install-skills.sh', /agents\/skills/],
  ['scripts/install-skills.sh', /agents\/dist/],
  ['scripts/check-agent-os.js', /agents\/dist/],
  ['scripts/check-identity-dist-fresh.js', /check-agent-os\.js/],
  ['lib/agent-personas.js', /agents\/personas/],
];

for (const [relPath, pattern] of expectedNewPathRefs) {
  if (!fileExists(repoRoot, relPath)) continue;
  if (!pattern.test(readText(repoRoot, relPath))) {
    errors.push(`${relPath} does not reference the new agents/ distribution path`);
  }
}

requireTrackedAbsent(repoRoot, ['identity', 'skills'], errors);

const files = activeTextFiles(repoRoot, [
  'agents',
  'scripts',
  'lib',
  'routes',
  'tests',
  'config',
  'docs',
  '.',
], ['apps/static/', 'lib/public-chat/']);

errors.push(...scanLegacyReferences(repoRoot, files, LEGACY_AGENT_RULES, {
  allow: () => false,
}));

failOrPass('check-agent-os-distribution', errors, 'ok - Agent OS source and distribution point at agents/');
