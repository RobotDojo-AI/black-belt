#!/usr/bin/env node
/**
 * ingest-voices.js — Classify writing samples into canonical registers,
 * augment per-register voice docs with evidence, and synthesize the generated
 * cross-register voice index (wk_user/user-voice/voice-index.md).
 *
 * Usage:
 *   node scripts/ingest-voices.js [options]
 *
 * Options:
 *   --samples <dir>       Directory of writing samples (default: wk_user/user-voice/samples/)
 *   --source gmail:<email>  Also fetch sent mail from Gmail account
 *   --dry-run             Report what would be done; skip all API calls and writes
 *   --force-augment       Replace existing "## Evidence from samples" sections
 *   --voice-dir <dir>     Override voice docs directory
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

import {
  extractText,
  computeFeatures,
  classifyRegister,
  disambiguateWithHaiku,
  augmentVoiceDoc,
  synthesizeVoiceMd,
  fetchGmailSentMail,
  CANONICAL_REGISTERS,
} from '../lib/voice-ingest.js';

import { getProvider } from '../lib/llm/index.js';
import { getValidAccessToken } from '../lib/google-oauth.js';

export const INTELLIGENCE_TIER = 'synthesis';

// ── Parse args ─────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    samples:       { type: 'string' },
    source:        { type: 'string' },
    'dry-run':     { type: 'boolean', default: false },
    'force-augment': { type: 'boolean', default: false },
    'voice-dir':   { type: 'string' },
  },
  allowPositionals: true,
});

const REPO_ROOT   = resolve(homedir(), 'robotdojo');
// Owner voice samples + register docs are gitignored local data under the user
// workbench, not shipped config.
const USER_VOICE_DIR = resolve(REPO_ROOT, 'user/workbenches/user/wk_user/user-voice');
const SAMPLES_DIR = args.samples  ? resolve(args.samples) : resolve(USER_VOICE_DIR, 'samples');
const VOICES_DIR  = args['voice-dir'] ? resolve(args['voice-dir']) : resolve(USER_VOICE_DIR, 'registers');
const DRY_RUN     = args['dry-run'] ?? false;
const FORCE_AUGMENT = args['force-augment'] ?? false;

// Supported sample extensions (not zip, not subdirs by default)
const SUPPORTED_EXTS = new Set(['.txt', '.md', '.pdf', '.docx']);

// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(msg + '\n');
}

function warn(msg) {
  process.stderr.write('warn: ' + msg + '\n');
}

/**
 * Recursively collect all supported files from a directory.
 * Skips subdirectory names that are themselves register names (samples/proposal/, etc.)
 * to avoid double-counting structured samples. When the root samples dir is passed,
 * we DO descend into subdirs to pick up files.
 */
function collectSampleFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      // Recurse into subdirectories
      results.push(...collectSampleFiles(fullPath));
    } else if (SUPPORTED_EXTS.has(extname(entry.name).toLowerCase())) {
      results.push(fullPath);
    }
  }
  return results;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  // ── 1. Collect local samples ──────────────────────────────────────────
  if (!existsSync(SAMPLES_DIR)) {
    log(`No samples found: directory does not exist: ${SAMPLES_DIR}`);
    process.exit(0);
  }

  const localFiles = collectSampleFiles(SAMPLES_DIR);
  if (localFiles.length === 0) {
    log(`No samples found in ${SAMPLES_DIR}`);
    process.exit(0);
  }

  log(`${localFiles.length} samples found in ${SAMPLES_DIR}`);

  // ── 2. Optionally fetch Gmail sent mail ───────────────────────────────
  const gmailSamples = [];
  if (args.source && args.source.startsWith('gmail:')) {
    const email = args.source.slice(6).trim();
    if (DRY_RUN) {
      log(`[dry-run] Would fetch Gmail sent mail for ${email}`);
    } else {
      try {
        log(`Fetching Gmail sent mail for ${email}...`);
        const msgs = await fetchGmailSentMail(email, getValidAccessToken);
        log(`  fetched ${msgs.length} sent messages`);
        gmailSamples.push(...msgs);
      } catch (err) {
        warn(`${err.message}`);
      }
    }
  }

  // ── 3. Extract + classify each local sample ───────────────────────────
  const client = DRY_RUN ? null : await getProvider('anthropic');

  /** @type {Map<string, Array<{filename, text}>>} register → samples */
  const byRegister = new Map();
  for (const reg of CANONICAL_REGISTERS) byRegister.set(reg, []);

  let skipped = 0;
  const classificationResults = [];

  for (const filePath of localFiles) {
    const filename = basename(filePath);
    let text;

    if (DRY_RUN) {
      // In dry-run, skip actual extraction — just note the file
      classificationResults.push({ filename, register: '(dry-run)', confidence: null });
      continue;
    }

    text = await extractText(filePath);
    if (!text || text.trim().length === 0) {
      warn(`skipped: ${filename} (no text content extracted)`);
      skipped++;
      continue;
    }

    const features = computeFeatures(text);
    if (!features) {
      warn(`skipped: ${filename} (feature extraction failed)`);
      skipped++;
      continue;
    }

    let result = classifyRegister(features);

    // Tier-1 disambiguation when top two registers are too close
    if (result.needsDisambiguation && client) {
      const haiku = await disambiguateWithHaiku(text, result.topTwo, result.register);
      if (haiku.register !== result.register) {
        warn(`  ${filename}: Haiku overrode Tier-0 ${result.register} → ${haiku.register} (confidence ${haiku.confidence.toFixed(2)})`);
      }
      result = { ...result, register: haiku.register, confidence: haiku.confidence };
    }

    byRegister.get(result.register)?.push({ filename, text });
    classificationResults.push({ filename, register: result.register, confidence: result.confidence });
  }

  // ── 4. Classify Gmail samples (Tier-0 only, no Haiku to save cost) ────
  if (!DRY_RUN) {
    for (const msg of gmailSamples) {
      const features = computeFeatures(msg.text);
      if (!features) continue;
      const result = classifyRegister(features);
      byRegister.get(result.register)?.push({ filename: `gmail:${msg.subject || 'sent'}`, text: msg.text });
    }
  }

  // ── 5. Report classification summary ─────────────────────────────────
  const summary = {};
  for (const [reg, samples] of byRegister) {
    if (samples.length > 0) summary[reg] = samples.length;
  }

  if (DRY_RUN) {
    const total = localFiles.length;
    log(`[dry-run] ${total} samples found: would classify + augment voice docs`);
    if (args.source) log(`[dry-run] Gmail source flag recognized: ${args.source}`);
    process.exit(0);
  }

  // Log classification results
  for (const { filename, register, confidence } of classificationResults) {
    const conf = confidence != null ? ` (${(confidence * 100).toFixed(0)}%)` : '';
    log(`  ${filename} → ${register}${conf}`);
  }
  if (skipped > 0) log(`  ${skipped} file(s) skipped (no extractable text)`);

  const summaryParts = Object.entries(summary).map(([r, n]) => `${n} ${r}`);
  log(`\nClassified: ${summaryParts.join(', ') || 'none'}`);

  // ── 6. Augment voice docs for registers with ≥2 samples ──────────────
  const augmented = [];
  for (const [register, samples] of byRegister) {
    if (samples.length < 2) continue;

    const voiceDocPath = resolve(VOICES_DIR, `${register}.md`);
    if (!existsSync(voiceDocPath)) {
      warn(`augmentation skipped: ${register} (voice doc not found at ${voiceDocPath})`);
      continue;
    }

    log(`Augmenting ${register}.md with ${samples.length} samples...`);
    const updated = client ? await augmentVoiceDoc(voiceDocPath, samples, { forceAugment: FORCE_AUGMENT }) : null;
    if (updated === null) {
      if (!FORCE_AUGMENT) {
        warn(`augmentation skipped: ${register} (already has Evidence section; use --force-augment to replace)`);
      } else {
        warn(`augmentation skipped: ${register} (Sonnet call failed)`);
      }
      continue;
    }

    writeFileSync(voiceDocPath, updated, 'utf8');
    augmented.push(register);
    log(`  updated ${voiceDocPath}`);
  }

  // ── 7. Synthesize the generated cross-register voice index ─────────────────
  const detectedRegisters = [...byRegister.entries()]
    .filter(([, s]) => s.length > 0)
    .map(([r]) => r);

  if (detectedRegisters.length === 0) {
    log('\nNo registers detected — skipping voice-index synthesis');
    await runLearn();
    process.exit(0);
  }

  log(`\nSynthesizing the voice index for ${detectedRegisters.length} register(s)...`);
  const voiceMd = client ? await synthesizeVoiceMd(detectedRegisters) : null;
  if (!voiceMd) {
    warn('voice-index synthesis failed — index not written');
    // Exit 0 — partial success
    summarize(augmented, detectedRegisters, false);
    await runLearn();
    process.exit(0);
  }

  // Generated index — distinct from the hand-curated INDEX.md router.
  mkdirSync(USER_VOICE_DIR, { recursive: true });
  const voiceMdPath = resolve(USER_VOICE_DIR, 'voice-index.md');
  writeFileSync(voiceMdPath, voiceMd, 'utf8');
  log(`  written ${voiceMdPath}`);

  summarize(augmented, detectedRegisters, true);
  await runLearn();
}

async function runLearn() {
  try {
    const { maybeLearnOwnerVoice } = await import('../lib/writing-learn.js');
    const learned = await maybeLearnOwnerVoice({ voiceDir: USER_VOICE_DIR });
    if (learned.learned) log(`owner voice.md compounded (next bar ${learned.nextChars} chars)`);
  } catch (err) {
    warn(`voice-learn skipped: ${err.message}`);
  }
}

function summarize(augmented, detected, voiceMdWritten) {
  log('\n── Summary ──────────────────────────────────────────────────────────');
  log(`Registers detected: ${detected.join(', ')}`);
  log(`Voice docs augmented: ${augmented.length > 0 ? augmented.join(', ') : 'none'}`);
  log(`voice-index.md: ${voiceMdWritten ? 'written' : 'not written (synthesis failed)'}`);
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
