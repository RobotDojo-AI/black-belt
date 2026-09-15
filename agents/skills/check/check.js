#!/usr/bin/env node
/**
 * check.js — Reason about whether a draft drifts from the owner's aspirational
 * voice, per the owner's drift tendencies. Auto-run by /write on its output.
 *
 * Intelligence tier: synthesis — reads the owner voice corpus + the draft and
 * calls the frontier model to REASON about drift (judgment cases like
 * under-selling and faint negativity, not a literal pattern match). Flags only;
 * never rewrites the draft, never blocks. The owner edits.
 *
 * Usage:
 *   node agents/skills/check/check.js --draft <file>
 *   echo "<prose>" | node agents/skills/check/check.js
 *
 * Output:
 *   Owner-facing drift flags to stdout. One line per flag: quoted line,
 *   tendency, fix. "No drift flags." when clean.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

import { getAnthropicClient } from '../../../lib/anthropic-client.js';
import { MODELS } from '../../../lib/compute-tier.js';

export const INTELLIGENCE_TIER = 'synthesis';

// ── Paths ──────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(homedir(), 'robotdojo');
// Owner voice corpus (gitignored local data). base.md is the aspirational
// target; check.md is the appendable list of drift tendencies to catch.
const USER_VOICE_DIR = resolve(REPO_ROOT, 'user/workbenches/user/wk_user/user-voice');
const BASE_PATH = resolve(USER_VOICE_DIR, 'voice.md');
const CHECK_PATH = resolve(USER_VOICE_DIR, 'check.md');

// ── Parse args ─────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    draft: { type: 'string' },
  },
  allowPositionals: true,
});

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  // Draft from --draft <file> or stdin.
  let draft = '';
  if (args.draft) {
    if (!existsSync(args.draft)) {
      process.stderr.write(`error: draft file not found: ${args.draft}\n`);
      process.exit(1);
    }
    draft = readFileSync(args.draft, 'utf8');
  } else {
    draft = readStdin();
  }
  if (!draft.trim()) {
    process.stderr.write('error: no draft provided (pass --draft <file> or pipe prose on stdin)\n');
    process.exit(1);
  }

  // The aspirational target and the tendencies list. If check.md is absent the
  // check still runs against base.md alone, but it is meant to have both.
  const baseVoice = existsSync(BASE_PATH) ? readFileSync(BASE_PATH, 'utf8') : '';
  const tendencies = existsSync(CHECK_PATH) ? readFileSync(CHECK_PATH, 'utf8') : '';
  if (!tendencies) {
    process.stderr.write(`warn: check list not found at ${CHECK_PATH} — reasoning against base voice only\n`);
  }

  const system = [
    'You are a voice reviewer for one specific owner. You read a draft and reason',
    'about how it drifts from the owner\'s aspirational writing voice. You REASON;',
    'you do not pattern-match. The point is to catch the judgment cases a regex',
    'cannot: a line that under-sells a true strength, a faintly negative or',
    'self-deprecating turn, a hedge that softens a real claim. A literal diminisher',
    'is the floor, not the ceiling — a neutral-looking line can still trip a',
    'tendency on tone.',
    '',
    'You FLAG; you never rewrite the draft and never block. Surface each drift and',
    'let the owner decide.',
    '',
    '## Aspirational voice (the target — base.md)',
    baseVoice || '(base voice unavailable)',
    '',
    '## Drift tendencies to catch (check.md)',
    tendencies || '(tendencies list unavailable — reason from the base voice)',
    '',
    '## How to respond',
    'Reason line by line. For each tendency, decide whether the draft trips it,',
    'treating judgment tendencies (under-selling, negativity, tone) as judgment',
    'calls. Then output ONLY the flags, owner-facing, one per line in the form:',
    '  - "<quoted offending line>" — <tendency name> — <lighter-touch fix>',
    'If the draft is clean, output exactly: No drift flags.',
    'No preamble, no summary, no restating the draft.',
  ].join('\n');

  const client = getAnthropicClient();
  const msg = await client.messages.create({
    // Anthropic client. MODELS.sonnet is the house Anthropic id; modelFor()
    // currently resolves to xAI and 404s here.
    model: MODELS.sonnet,
    max_tokens: 1200,
    system,
    messages: [{ role: 'user', content: `Draft to check:\n\n${draft}` }],
  });

  const flags = msg.content[0]?.text?.trim() ?? '';
  process.stdout.write((flags || 'No drift flags.') + '\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
