#!/usr/bin/env node
/**
 * smart-quarantine-execute.js — stdin executor for AC #2 / AC #11 tests.
 *
 * Read a single decision JSON from stdin, run it through executeImpl with full
 * guards, exit non-zero on rejection.
 *
 * Usage:
 *   echo '{"action":"delete","file":"x","destination":"y"}' | node scripts/smart-quarantine-execute.js --stdin
 */

import { executeDecision } from '../lib/quarantine/index.js';

async function main() {
  if (!process.argv.includes('--stdin')) {
    console.error('Usage: ... | smart-quarantine-execute.js --stdin');
    process.exit(2);
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    console.error('no input on stdin');
    process.exit(2);
  }

  let decision;
  try {
    decision = JSON.parse(raw);
  } catch (err) {
    console.error(`invalid JSON on stdin: ${err.message}`);
    process.exit(2);
  }

  try {
    const result = await executeDecision(decision);
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    console.error(`rejected: ${err.message}`);
    process.exit(1);
  }
}

main();
