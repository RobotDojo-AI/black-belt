#!/usr/bin/env node
/**
 * write.js — Generate prose in the user's voice for a given register and brief.
 *
 * Usage:
 *   node agents/skills/write/write.js --voice <register> --brief "<text>"
 *
 * Options:
 *   --voice <name>       Channel (linkedin, gmail, email, sms) or register
 *                        (essay, memo, deck, …) — see wk_user/user-voice/INDEX.md
 *   --brief <text>       What to write — topic, outline, or raw brief
 *   --context <file>     Optional extra context file to include
 *
 * Output:
 *   Prose written to stdout. No metadata, no preamble.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';

import { getAnthropicClient } from '../../../lib/anthropic-client.js';

// ── Parse args ─────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    voice:    { type: 'string' },
    brief:    { type: 'string' },
    context:  { type: 'string' },
    'no-check': { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (!args.voice) {
  process.stderr.write('error: --voice <register> is required\n');
  process.stderr.write('usage: node agents/skills/write/write.js --voice <register> --brief "<text>"\n');
  process.exit(1);
}

if (!args.brief) {
  process.stderr.write('error: --brief "<text>" is required\n');
  process.stderr.write('usage: node agents/skills/write/write.js --voice <register> --brief "<text>"\n');
  process.exit(1);
}

// ── Paths ──────────────────────────────────────────────────────────────────

const REPO_ROOT   = resolve(homedir(), 'robotdojo');
// Owner voice (the base register, per-channel files, and per-document-type
// registers) is gitignored local data under the user workbench — not shipped
// config. The PII-free agent voice (how the agent talks to the owner) lives
// separately in config/agent-voice/.
const VOICES_DIR  = resolve(REPO_ROOT, 'user/workbenches/user/wk_user/user-voice');
const FORMATTING_DIR = resolve(VOICES_DIR, 'formatting');
const STRUCTURE_DIR = resolve(VOICES_DIR, 'structure');

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const register = args.voice;
  const brief = args.brief;

  // Resolve the voice doc: channel (linkedin, gmail, email, sms) takes
  // precedence over a same-named register, then fall back to registers
  // (essay, memo, deck, …). Channels carry the surface format; registers carry
  // the document-type voice.
  const formattingPath = resolve(FORMATTING_DIR, `${register}.md`);
  const structurePath = resolve(STRUCTURE_DIR, `${register}.md`);
  const voiceDocPath = existsSync(formattingPath) ? formattingPath
    : existsSync(structurePath) ? structurePath
    : null;
  if (!voiceDocPath) {
    process.stderr.write(`error: writing doc not found for "${register}"\n`);
    process.stderr.write(`available formatting: run ls ${FORMATTING_DIR}\n`);
    process.stderr.write(`available structure: run ls ${STRUCTURE_DIR}\n`);
    process.exit(1);
  }

  const extraContext = args.context && existsSync(args.context)
    ? readFileSync(args.context, 'utf8')
    : null;

  const { generate } = await import('../../../lib/writing.js');
  const block = await generate({
    speaker: 'owner',
    brief,
    structure: existsSync(structurePath) ? register : null,
    formatting: existsSync(formattingPath) ? register : null,
    extraContext,
  });
  const prose = block.body;
  // Raw prose to stdout so callers can pipe it cleanly.
  process.stdout.write(prose + '\n');

  // Auto-run /check on the draft: it reasons the prose against the owner's
  // drift tendencies and surfaces flags for the owner. Review output goes to
  // stderr so piped stdout stays clean prose. Opt out with --no-check or
  // ROBOTDOJO_SKIP_CHECK=1 (e.g. environments without a model key).
  if (!args['no-check'] && process.env.ROBOTDOJO_SKIP_CHECK !== '1' && prose.trim()) {
    const checkScript = resolve(REPO_ROOT, 'agents/skills/check/check.js');
    const res = spawnSync(process.execPath, [checkScript], {
      input: prose,
      encoding: 'utf8',
    });
    const flags = (res.stdout || '').trim();
    if (flags) {
      process.stderr.write(`\n── /check drift flags ──\n${flags}\n`);
    } else if (res.stderr) {
      process.stderr.write(`\n── /check unavailable ──\n${res.stderr.trim()}\n`);
    }
  }
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
