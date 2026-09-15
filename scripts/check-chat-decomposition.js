#!/usr/bin/env node
/**
 * check-chat-decomposition.js
 *
 * Registry-driven gate that verifies the chat-launch-quality (st_74f45a1a)
 * decomposition is in place. For each named load-bearing concern:
 *   - the module file exists at the expected path
 *   - a per-concern behavioral test exists at tests/chat/{name}.test.js
 *   - the test imports the module (regex check on test file content)
 *
 * Exits 0 when every concern resolves; exits 1 with a per-concern failure
 * list otherwise. The registry IS the gate's predicate — no hardcoded counts.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Load-bearing concerns. Each entry: { name, modulePath, testPath, importHint }.
// importHint is a substring (or string used as a regex) that the test file
// must reference to prove it imports the module.
const REGISTRY = [
  // Client-side
  { name: 'stream-client',   modulePath: 'apps/chat/modules/stream-client.js',  testPath: 'tests/chat/stream-client.test.js',  importHint: 'stream-client.js' },
  { name: 'stream-parser',   modulePath: 'apps/chat/modules/stream-parser.js',  testPath: 'tests/chat/stream-parser.test.js',  importHint: 'stream-parser.js' },
  { name: 'indicator',       modulePath: 'apps/chat/modules/indicator.js',     testPath: 'tests/chat/indicator.test.js',      importHint: 'indicator.js' },
  { name: 'error-ui',        modulePath: 'apps/chat/modules/error-ui.js',      testPath: 'tests/chat/error-ui.test.js',       importHint: 'error-ui.js' },
  // Lib-side
  { name: 'system-prompt',   modulePath: 'lib/chat/system-prompt.js',          testPath: 'tests/chat/system-prompt.test.js',  importHint: 'system-prompt.js' },
  { name: 'anthropic-loop',  modulePath: 'lib/chat/anthropic-loop.js',         testPath: 'tests/chat/anthropic-loop.test.js', importHint: 'anthropic-loop.js' },
];

const failures = [];

for (const concern of REGISTRY) {
  const absModule = join(REPO, concern.modulePath);
  const absTest = join(REPO, concern.testPath);

  if (!existsSync(absModule)) {
    failures.push(`${concern.name}: module file missing → ${concern.modulePath}`);
    continue;
  }
  if (!existsSync(absTest)) {
    failures.push(`${concern.name}: test file missing → ${concern.testPath}`);
    continue;
  }
  // The test must import the module — verify by regex on file contents.
  let testContent;
  try {
    testContent = readFileSync(absTest, 'utf8');
  } catch (err) {
    failures.push(`${concern.name}: could not read test file (${err.message})`);
    continue;
  }
  if (!testContent.includes(concern.importHint)) {
    failures.push(`${concern.name}: test ${concern.testPath} does not import ${concern.importHint}`);
  }
}

if (failures.length > 0) {
  console.error('[check-chat-decomposition] FAILED');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}

console.log(`[check-chat-decomposition] ok — ${REGISTRY.length} concerns verified`);
process.exit(0);
