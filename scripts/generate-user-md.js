#!/usr/bin/env node
/**
 * scripts/generate-user-md.js — wk_user/USER.md inference engine CLI
 *
 * Generates ~/robotdojo/wk_user/USER.md from the owner's corpus (correction phrases,
 * memory log, chat history) without form fields or manual curation. Then runs
 * generate-identity.js to update dist/claude.md.
 *
 * WHY this is a script, not a lib function:
 *   All I/O decisions, flag handling, and side effects live here. The engine
 *   (lib/generate-user-md.js) stays pure — no disk writes, no process.exit.
 *   This separation keeps the engine testable and the script auditable.
 *
 * Flags:
 *   --dry-run          Run all collection + synthesis, print summary, do NOT write files
 *   --corrections-only Run Tier 0 only (correction-phrases.js), print to stdout, exit
 *   --force            Bypass no-overwrite protection (re-run after hand-edit)
 *
 * No-overwrite protection:
 *   Reads wk_user/USER.md and checks for AI-generated marker in first 5 lines.
 *   If marker is absent (hand-edited file), logs and exits 0 without touching it.
 *   Override with --force.
 *
 * Exit codes:
 *   0 — success (or skipped due to hand-edit protection)
 *   1 — unrecoverable error (API failure, missing dependency)
 */

import { dirname, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gather as gatherCorrections } from '../lib/distill-sources/correction-phrases.js';
import { synthesize } from '../lib/generate-user-md.js';
import { USER_PROFILE_PATH } from '../lib/robotdojo-paths.js';

// --- Constants ---------------------------------------------------------------

const AI_MARKER = '<!-- AI-generated: do not hand-edit; run generate-user-md.js to regenerate -->';
const USER_MD_PATH = USER_PROFILE_PATH;
const ANALYSIS_PATH = join(dirname(USER_PROFILE_PATH), 'profile-analysis.md');
// Script's own directory for resolving generate-identity.js
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// --- Flag parsing ------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN          = args.includes('--dry-run');
const CORRECTIONS_ONLY = args.includes('--corrections-only');
const FORCE            = args.includes('--force');

// --- Mode: --corrections-only -----------------------------------------------
// Zero LLM calls. Print correction phrase data from Tier 0 SQL extraction.
if (CORRECTIONS_ONLY) {
  const phrases = gatherCorrections();
  if (!phrases.length) {
    console.log('No correction phrases found in corpus.');
  } else {
    console.log(`Correction phrases found in ${phrases.reduce((s, p) => s + p.count, 0)} user messages:\n`);
    for (const p of phrases) {
      console.log(`  "${p.phrase}" — ${p.count} occurrences`);
      for (const ex of p.examples.slice(0, 2)) {
        console.log(`    -> ${ex}`);
      }
    }
  }
  process.exit(0);
}

// --- No-overwrite protection -------------------------------------------------
// If wk_user/USER.md exists and lacks the AI-generated marker, it has been hand-edited.
// Refuse to overwrite unless --force is set.

async function checkOverwriteProtection() {
  if (FORCE || DRY_RUN) return true; // force or dry-run: skip check

  if (!existsSync(USER_MD_PATH)) return true; // file doesn't exist: ok to write

  const content = await readFile(USER_MD_PATH, 'utf8');
  const first5Lines = content.split('\n').slice(0, 5).join('\n');
  if (first5Lines.toLowerCase().includes('ai-generated')) {
    return true; // marker present: safe to overwrite
  }

  // No marker — file was hand-edited. Respect the edit.
  console.log('wk_user/USER.md has been hand-edited; skipping write. Run with --force to overwrite.');
  return false;
}

// --- Generate-identity runner ------------------------------------------------
// Runs generate-identity.js as a subprocess. Errors are reported but do not
// prevent wk_user/USER.md / profile-analysis.md from being written.

function runBuildIdentity() {
  return new Promise((resolve) => {
    const buildScript = join(REPO_ROOT, 'scripts', 'generate-identity.js');
    const child = spawn(process.execPath, [buildScript], {
      stdio: 'inherit',
      cwd: REPO_ROOT,
    });
    child.on('close', (code) => {
      if (code !== 0) {
        console.error(`generate-identity.js exited with code ${code} — wk_user/USER.md and profile-analysis.md were written but identity dist adapters may be stale`);
      }
      resolve(code);
    });
    child.on('error', (err) => {
      console.error(`generate-identity.js failed to start: ${err.message}`);
      resolve(1);
    });
  });
}

// --- Main --------------------------------------------------------------------

async function main() {
  // Check overwrite protection before making any API calls
  const canWrite = await checkOverwriteProtection();
  if (!canWrite) {
    process.exit(0);
  }

  console.log(`Running wk_user/USER.md synthesis${DRY_RUN ? ' (dry-run — no files will be written)' : ''}...`);

  let result;
  try {
    result = await synthesize();
  } catch (err) {
    console.error(`Synthesis failed: ${err.message}`);
    process.exit(1);
  }

  const { userMd, analysis, usage } = result;

  // Prepend AI-generated marker on line 1 of wk_user/USER.md
  const finalUserMd = `${AI_MARKER}\n${userMd}`;

  const lineCount = finalUserMd.split('\n').length;
  console.log(`Synthesis complete — ${lineCount} lines, ${usage.pass1?.output_tokens || 0}+${usage.pass2?.output_tokens || 0} output tokens`);

  if (DRY_RUN) {
    console.log('\n--- DRY RUN: wk_user/USER.md preview (first 20 lines) ---');
    console.log(finalUserMd.split('\n').slice(0, 20).join('\n'));
    console.log('--- (skipped disk write + generate-identity.js) ---');
    return;
  }

  // Write wk_user/USER.md and profile-analysis.md
  await writeFile(USER_MD_PATH, finalUserMd, 'utf8');
  await writeFile(ANALYSIS_PATH, analysis, 'utf8');
  console.log(`Wrote: ${USER_MD_PATH}`);
  console.log(`Wrote: ${ANALYSIS_PATH}`);

  // Run generate-identity.js to rebuild identity adapters
  await runBuildIdentity();
}

main().catch((err) => {
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});
