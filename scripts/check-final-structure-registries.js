#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

import {
  RETIRED_PRIVATE_ROOTS,
  failOrPass,
  fileExists,
  parseArgs,
  readText,
} from './check-final-structure-lib.js';
import { loadRootLock } from './root-lock-lib.js';

const { repoRoot } = parseArgs();
const errors = [];

let rootLock = null;
try {
  rootLock = loadRootLock(repoRoot);
} catch (err) {
  errors.push(err.message);
}

const dirs = rootLock?.entries || {};
for (const required of ['agents', 'user']) {
  if (!Object.prototype.hasOwnProperty.call(dirs, required)) {
    errors.push(`config/root-allowlist.lock.json missing ${required}/`);
  }
}
for (const retired of ['identity', 'skills', ...RETIRED_PRIVATE_ROOTS]) {
  if (Object.prototype.hasOwnProperty.call(dirs, retired)) {
    errors.push(`config/root-allowlist.lock.json still declares retired root ${retired}/`);
  }
}

if (fileExists(repoRoot, 'config/structure.json')) {
  const text = readText(repoRoot, 'config/structure.json');
  for (const retired of ['identity', 'skills', ...RETIRED_PRIVATE_ROOTS]) {
    if (new RegExp(`"${retired}/?"\\s*:`).test(text)) {
      errors.push(`config/structure.json still declares retired root ${retired}/`);
    }
  }
}

if (!fileExists(repoRoot, 'scripts/gate.js')) {
  errors.push('missing scripts/gate.js');
} else {
  const gate = readText(repoRoot, 'scripts/gate.js');
  if (!gate.includes('loadRootLock')) errors.push('scripts/gate.js must load config/root-allowlist.lock.json');
  for (const retired of ['identity', 'skills']) {
    if (new RegExp(`['"\`]${retired}['"\`]`).test(gate)) {
      errors.push(`scripts/gate.js still allows retired root ${retired}/`);
    }
  }
}

if (!fileExists(repoRoot, '.vercelignore')) {
  errors.push('missing .vercelignore');
} else {
  const ignore = readText(repoRoot, '.vercelignore');
  if (!/^user\/?$/m.test(ignore)) errors.push('.vercelignore must exclude user/');
}

if (!fileExists(repoRoot, 'lib/private-data-roots.js')) {
  errors.push('missing lib/private-data-roots.js');
} else {
  const roots = readText(repoRoot, 'lib/private-data-roots.js');
  if (!/local:\s*['"`]user['"`]/.test(roots) && !/key:\s*['"`]user['"`]/.test(roots)) {
    errors.push('lib/private-data-roots.js must back up user/ as the private substrate root');
  }
  for (const retired of ['identity', 'skills', ...RETIRED_PRIVATE_ROOTS]) {
    if (new RegExp(`local:\\s*['"\`]${retired}(?:/|['"\`])`).test(roots)) {
      errors.push(`lib/private-data-roots.js still backs up retired top-level root ${retired}/`);
    }
  }
}

failOrPass('check-final-structure-registries', errors, 'ok - registries enforce final root model');
