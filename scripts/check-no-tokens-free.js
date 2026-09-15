#!/usr/bin/env node
/**
 * scripts/check-no-tokens-free.js — the retired ethos stays retired.
 *
 * st_4312c9c0 AC-12. "Tokens are free. The model is paid for." was true on a
 * flat-rate subscription and is exactly backwards on the owner's metered API
 * key, where every call bills with no ceiling. It was removed from the quality
 * contract and resynced into all six personas.
 *
 * The failure this guards is not a deliberate re-add. It is a stale copy: the
 * personas carry inlined fragment bodies, several skills quote the contract,
 * and the distributed Claude/Codex/Cursor adapters are generated from all of
 * them. Regenerating from a stale source, or hand-editing one persona, quietly
 * reintroduces the line in one file while the other seven look correct.
 *
 * Scans the whole agent system — sources, personas, skills, and the generated
 * adapters — because a rule the adapters still carry is a rule the agents still
 * follow, whatever the source says.
 *
 * Exit 0 = the phrase is gone. Exit 1 = it is back, with every file named.
 */

// INTELLIGENCE_TIER: extraction — deterministic text scan. Makes no model call.
export const INTELLIGENCE_TIER = 'extraction';

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const REPO_ROOT = resolve(process.argv.includes('--repo')
  ? process.argv[process.argv.indexOf('--repo') + 1]
  : join(import.meta.dirname, '..'));

// Case-insensitive: a resync or a hand-edit can change capitalisation while
// leaving the claim intact, and the claim is what is wrong.
const BANNED = /tokens\s+are\s+free/i;

// The whole agent system, sources and generated outputs alike.
const ROOTS = ['agents'];
const EXTENSIONS = ['.md', '.mdc'];

// This file necessarily contains the phrase it bans.
const SELF = 'scripts/check-no-tokens-free.js';

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(abs);
    } else if (EXTENSIONS.some((e) => name.endsWith(e))) {
      yield abs;
    }
  }
}

function main() {
  const hits = [];
  let scanned = 0;
  for (const root of ROOTS) {
    for (const abs of walk(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, abs);
      if (rel === SELF) continue;
      scanned++;
      const text = readFileSync(abs, 'utf8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (BANNED.test(lines[i])) hits.push(`${rel}:${i + 1}`);
      }
    }
  }

  if (hits.length) {
    process.stderr.write(`check-no-tokens-free: FAIL — the retired cost model is back in ${hits.length} place(s):\n`);
    for (const h of hits) process.stderr.write(`  - ${h}\n`);
    process.stderr.write('\nEdit agents/default-quality.md, then:\n');
    process.stderr.write('  node scripts/resync-persona-fragments.js --all && node scripts/generate-identity.js\n');
    return 1;
  }

  process.stdout.write(`check-no-tokens-free: ok — ${scanned} agent file(s) clean\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
