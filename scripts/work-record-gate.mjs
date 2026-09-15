#!/usr/bin/env node
// scripts/work-record-gate.mjs — st_862d73d1 AC1.
//
// Installed to ~/.claude/hooks/work-record-gate.mjs and registered as a
// UserPromptSubmit hook. Makes a `/work {workbench}` intake record structurally
// guaranteed: the runtime — not the agent — runs this before the prompt reaches
// the model, so a skipped open step cannot produce an untracked session.
//
// Behavior:
//   /work {workbench}  → run story-init.js --type work --workbench <slug>
//                        (find-or-create — idempotent). On success exit 0 (allow);
//                        on creation failure emit {decision:"block", reason,
//                        systemMessage} on stdout AND the same string on stderr
//                        (doc-ambiguity insurance: the reason channel for
//                        UserPromptSubmit is documented inconsistently, so set
//                        both, and exit 2 so a runtime that honors exit-code
//                        blocking also blocks).
//   /story | /defect   → allow (their /framing auto-hop is the genuine
//                        downstream guard; covered here for symmetry only).
//   anything else      → allow (cheap hot path: string-match first, only spawn
//                        node-as-side-effect when a /work pattern actually hits).
//
// Contract: must be fast (UserPromptSubmit has a ~30s timeout and blocks model
// processing). Match-first; only run story-init on a real /work hit. Never throw
// — any internal error allows the prompt (fail-open for the non-/work path; the
// close-time backstop in work/SKILL.md is the hard, surface-independent floor).

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// Resolve story-init.js relative to this file when it sits in the repo; fall
// back to the canonical repo path when installed under ~/.claude/hooks/.
function storyInitPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = resolve(here, 'story-init.js');
  // When installed in ~/.claude/hooks/, the sibling won't exist — use the repo.
  return sibling.includes('/.claude/hooks/')
    ? resolve(homedir(), 'robotdojo', 'scripts', 'story-init.js')
    : sibling;
}

function allow() {
  // UserPromptSubmit: exit 0 with no JSON = allow.
  process.exit(0);
}

function block(reason) {
  // Set BOTH channels (reason + systemMessage) AND stderr + exit 2, so the
  // BLOCKED message reaches the user regardless of how the runtime routes it.
  const payload = { decision: 'block', reason, systemMessage: reason };
  process.stdout.write(JSON.stringify(payload));
  process.stderr.write(reason + '\n');
  process.exit(2);
}

async function main() {
  // node:fs is loaded lazily so the hot path stays cheap; readStdin uses it.
  const { readFileSync } = await import('node:fs');
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin → allow */ }
  let prompt = '';
  try {
    const j = JSON.parse(raw);
    prompt = String(j.prompt || '');
  } catch {
    // Not JSON — allow (don't gate on malformed input).
    return allow();
  }

  const trimmed = prompt.trim();

  // /story and /defect: allow (their /framing auto-hop is the downstream guard).
  if (/^\/(story|defect)\b/.test(trimmed)) return allow();

  // /work {workbench}: the gated case.
  const m = trimmed.match(/^\/work\s+(\S+)/);
  if (!m) return allow(); // bare /work or non-/work prompt → allow

  const workbench = m[1];
  const r = spawnSync('node', [
    storyInitPath(),
    '--type', 'work',
    '--domain', 'robotdojo',
    '--workbench', workbench,
    '--name', `work-${workbench}`,
    '--desc', `work session: ${workbench}`,
    '--quiet',
  ], { encoding: 'utf8', timeout: 20000 });

  if (r.status !== 0) {
    return block(
      `BLOCKED: could not create a tracked record for /work ${workbench}. ` +
      `${(r.stderr || '').trim() || 'story-init.js failed.'} ` +
      `Fix the record path before working so the session is not untracked.`,
    );
  }
  // Record exists (created or found) — allow the prompt to proceed.
  return allow();
}

main().catch(() => allow());
