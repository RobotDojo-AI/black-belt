#!/usr/bin/env node
/**
 * Canonical Agent OS generator facade.
 *
 * `generate-identity.js` still holds the implementation name for historical
 * continuity; this wrapper gives the final architecture a name that matches
 * the `agents/` source tree.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const target = args.includes('--check') ? 'check-identity-dist-fresh.js' : 'generate-identity.js';
const nextArgs = args.filter((arg) => arg !== '--check');

const result = spawnSync(
  process.execPath,
  [join(scriptsDir, target), ...nextArgs],
  { stdio: 'inherit' },
);

process.exit(result.status ?? 1);
