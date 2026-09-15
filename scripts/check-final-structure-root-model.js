#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import {
  AGENT_NAMES,
  REQUIRED_SKILLS,
  failOrPass,
  fileExists,
  hasEntries,
  parseArgs,
  requirePaths,
  requireTrackedAbsent,
} from './check-final-structure-lib.js';

const { repoRoot } = parseArgs();
const errors = [];

requirePaths(repoRoot, [
  'agents',
  'agents/agents.md',
  'agents/personas',
  'agents/skills',
  'agents/default-quality.md',
  'agents/build-conventions.md',
  'user',
  'user/.gitignore',
  'apps',
  'config',
  'docs',
  'lib',
  'routes',
  'scripts',
  'tests',
  'pipeline',
], errors);

for (const name of AGENT_NAMES) {
  if (!fileExists(repoRoot, `agents/personas/${name}.md`)) {
    errors.push(`missing canonical persona: agents/personas/${name}.md`);
  }
}

for (const name of REQUIRED_SKILLS) {
  if (!fileExists(repoRoot, `agents/skills/${name}/SKILL.md`)) {
    errors.push(`missing canonical skill: agents/skills/${name}/SKILL.md`);
  }
}

if (hasEntries(repoRoot, 'identity')) {
  errors.push('top-level identity/ still has entries; final Agent OS source must be agents/');
}
if (hasEntries(repoRoot, 'skills')) {
  errors.push('top-level skills/ still has entries; final skill source must be agents/skills/');
}
if (hasEntries(repoRoot, 'system')) {
  errors.push('system/ catch-all root exists; plan explicitly rejects a broad system root');
}
if (hasEntries(repoRoot, 'systems')) {
  errors.push('systems/ catch-all root exists; plan explicitly rejects a broad system root');
}
if (hasEntries(repoRoot, 'plans')) {
  errors.push('top-level plans/ still has entries; plans belong inside pipeline stories, defects, or workbenches');
}
if (hasEntries(repoRoot, 'test-results')) {
  errors.push('top-level test-results/ still has entries; test outputs must go to /tmp or a story QA artifact');
}
if (hasEntries(repoRoot, '.gstack')) {
  errors.push('top-level .gstack/ still has entries; legacy local tool output must not be a repo root');
}
if (hasEntries(repoRoot, 'qa-reports')) {
  errors.push('top-level qa-reports/ still has entries; QA evidence belongs in pipeline stories or /tmp output');
}

requireTrackedAbsent(repoRoot, ['identity', 'skills'], errors);

failOrPass('check-final-structure-root-model', errors, 'ok - root model is agents/ + user/ with no active identity/ or skills/');
