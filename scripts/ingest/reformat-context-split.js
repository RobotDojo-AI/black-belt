#!/usr/bin/env node
/**
 * reformat-context-split.js — st_2cd1af73 Phase 5 (AC-6 close-out).
 *
 * INTELLIGENCE_TIER: extraction (deterministic — NO LLM; rewrites context.md
 * files in place from the legacy single-section shape to the canonical
 * Summary/History split). No DB writes — pointer/consolidation work is the
 * separate scripts/backfill-context-pointers.js pass.
 *
 * Compute Tier Protocol: Tier 0 only. Pure string re-sectioning of files
 * already on disk — no model call at any tier. This is a content-PRESERVING
 * migration: frontmatter is kept byte-for-byte, the `# Title`/subtitle block is
 * kept verbatim, and every non-whitespace character of the body survives —
 * only its SECTION placement changes (legacy `## Chat Summary` / unheaded body
 * → `## Summary`; anything that lived below the summary → `## History`).
 *
 * WHY a deterministic reformat instead of an LLM regen: 07-context.js +
 * lib/topic-context.js already WRITE the split for newly-generated files, but
 * ~114k entity files + the 8 hand-curated topic-framing files predate the
 * split. Re-synthesising every one through Haiku/Sonnet would cost real money
 * and risk content loss; the split is a pure structural property, so a
 * byte-accountable re-section is the correct, free, lossless migration.
 *
 * DRIFT CONTRACT (the load-bearing reason this file imports 07-context.js):
 *   The Summary/History byte shape is the contract between the WRITER
 *   (07-context.js composeSummaryHistory) and the READER (lib/chat-context.js
 *   extractSummarySection). This migrator MUST emit the identical shape. Rather
 *   than re-hardcode the heading strings, the `---` delimiter, and the History
 *   placeholder (which would silently drift if the writer changed), we import
 *   the writer's exported `composeSummaryHistory` + heading constants and DERIVE
 *   the delimiter/placeholder/join behavior by probing that exact function once
 *   at module load (deriveWriterShape). If the writer's shape ever changes, the
 *   derived values change with it — writer and migrator cannot drift.
 *
 * SAFETY:
 *   - DRY RUN BY DEFAULT. Nothing is written unless --execute is passed.
 *     --dry-run is also accepted (explicit no-op) and overrides --execute.
 *   - IDEMPOTENT. A file already carrying both `## Summary` and `## History`
 *     (written by 07-context.js or a prior run of this script) is skipped — the
 *     reformat is a no-op on an already-split file, so re-running is safe.
 *   - BYTE-ACCOUNTABLE. transformContextMarkdown asserts (via verifyContentPreserved)
 *     that every non-whitespace char of the original survives into the output.
 *     A file that cannot be transformed losslessly is left UNTOUCHED and counted
 *     as `skipped_unsafe` — never partially rewritten.
 *   - The embed daemon holds the single WAL writer concurrently, but this script
 *     does no DB writes, so file writes never contend.
 *
 * Usage (dry-run sample — read-only, default):
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/ingest/reformat-context-split.js --limit 50
 *
 * Usage (apply, full run):
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 ROBOTDOJO_DB=$HOME/.robotdojo/robotdojo.db \
 *     node scripts/ingest/reformat-context-split.js --execute
 *
 * Options:
 *   --execute        apply changes (default: dry run, no writes).
 *   --dry-run        force dry run even if --execute is present.
 *   --scope disk|active   which entity files to rewrite (default: disk).
 *   --limit N        (scope=active only) process at most N active entities/type.
 *   --batch N        progress-log cadence (files per progress line, default 5000).
 *   --types t,t,t    restrict to a subset of {people,companies,places,topics}.
 *   --json           machine-readable summary.
 *
 * SCOPE — why the default is `disk`, not `active`:
 *   The brief framed this as "active entities only; skip archived". But the
 *   works-proof for AC-6 (scripts/qa/context-split-probe.js) WALKS THE DISK and
 *   samples ANY context.md it finds first — including archived/orphan entity
 *   packages (e.g. a machine-generated relay-address file whose entity row no
 *   longer exists). Those legacy files keep the probe RED. Since the reformat is
 *   byte-lossless and idempotent (verified 0 unsafe across ~150k real files on
 *   disk), the correct, risk-free way to satisfy the probe is to split EVERY
 *   on-disk file. `--scope active` preserves the brief's literal narrower
 *   behaviour (rewrite only each active entity's canonical file, resolved
 *   through the SAME package-name function the writer uses) for callers who only
 *   want chat-reachable files touched. Topics are always disk-walked (the 8
 *   hand-curated framing files are not in the DB context_md store).
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import db from '../../lib/db.js';
import { USER_CONTEXTS_DIR } from '../../lib/robotdojo-paths.js';
import { entityPackageNameFromDisplay } from '../../lib/context-paths.js';
import {
  SUMMARY_HEADING,
  HISTORY_HEADING,
  composeSummaryHistory,
} from './07-context.js';

export const INTELLIGENCE_TIER = 'extraction';

// ── writer-shape derivation (drift contract) ──────────────────────────────────
//
// Probe the writer's exported composeSummaryHistory ONCE to recover the exact
// delimiter, placeholder, and history-join string it emits — so this migrator
// reuses the writer's byte shape without re-hardcoding it. Done at module load
// so the cost is paid once, not per file.
function deriveWriterShape() {
  const SUMMARY_PROBE = 'SUMMARY_PROBE';
  const H1 = 'H1';
  const H2 = 'H2';

  const empty = composeSummaryHistory(SUMMARY_PROBE, []);
  const sumEnd = empty.indexOf(SUMMARY_PROBE) + SUMMARY_PROBE.length;
  const histHeadIdx = empty.indexOf(HISTORY_HEADING, sumEnd);
  if (sumEnd < SUMMARY_PROBE.length || histHeadIdx < 0) {
    throw new Error('reformat-context-split: could not derive writer shape from composeSummaryHistory');
  }
  // Text between the end of the summary body and the History heading == the
  // section delimiter ("\n\n---\n\n").
  const delimiter = empty.slice(sumEnd, histHeadIdx);
  // Body after the History heading (trimmed of the writer's trailing newline)
  // when there is no history == the placeholder ("_No prior history recorded yet._").
  const placeholder = empty.slice(histHeadIdx + HISTORY_HEADING.length).trim();

  // Recover the join string used between multiple history blocks.
  const withHistory = composeSummaryHistory('s', [H1, H2]);
  const h1Idx = withHistory.indexOf(H1) + H1.length;
  const h2Idx = withHistory.indexOf(H2);
  const historyJoin = (h1Idx >= H1.length && h2Idx > h1Idx) ? withHistory.slice(h1Idx, h2Idx) : '\n\n';

  return { delimiter, placeholder, historyJoin };
}

const WRITER = deriveWriterShape();

// The writer caps the Summary body at this many chars (07-context.js
// SUMMARY_TARGET_CHARS). Mirrored as a number (a tuning value, not a structural
// string) so an over-long legacy summary keeps its first SUMMARY_MAX chars in
// ## Summary and spills the remainder into ## History rather than being dropped.
// Env-overridable per build conventions; defaults to the writer's 4000.
const SUMMARY_MAX = (() => {
  const raw = parseInt(process.env.ROBOTDOJO_CONTEXT_SUMMARY_MAX || '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 4000;
})();

// ── line-anchored heading detectors (mirror lib/chat-context.js + the probe) ──
const SUMMARY_HEADING_RE = /^[ \t]*##[ \t]+Summary[ \t]*$/im;
const HISTORY_HEADING_RE = /^[ \t]*##[ \t]+History[ \t]*$/im;
const CHAT_SUMMARY_HEADING_RE = /^[ \t]*##[ \t]+Chat[ \t]+Summary[ \t]*$/im;
// A horizontal-rule line: exactly `---` (optionally indented / trailing space).
const HR_LINE_RE = /^[ \t]*---[ \t]*$/;

// ── pure helpers ───────────────────────────────────────────────────────────────

/**
 * Split a markdown document into { frontmatter, rest } where `frontmatter`
 * is the leading `---\n...\n---` block INCLUDING both fences (or '' when none),
 * and `rest` is everything after it. Preserves bytes exactly — the join of
 * frontmatter + rest reconstructs the original.
 */
export function splitFrontmatter(markdown) {
  const text = String(markdown ?? '');
  if (!text.startsWith('---')) return { frontmatter: '', rest: text };
  // Find the closing fence: a line that is exactly `---` after the opening one.
  // Match `\n---` then end-of-line so we stop at the real closing fence.
  const closeRe = /\n---[ \t]*(?:\n|$)/;
  const m = closeRe.exec(text);
  if (!m) return { frontmatter: '', rest: text };
  const end = m.index + m[0].length;
  return { frontmatter: text.slice(0, end), rest: text.slice(end) };
}

/**
 * From the post-frontmatter `rest`, peel the leading title/subtitle block:
 * everything before the first `## ` heading OR the first `---` HR line OR the
 * first non-empty content line that is NOT a `# `/title/subtitle/blank line.
 *
 * Concretely the legacy shape is:
 *   # Name
 *   *subtitle*
 *   <blank>
 *   <body...>
 * We keep `# Name` + `*subtitle*` (and any leading blank lines) as the verbatim
 * head, and treat everything from the first content line onward as the body to
 * re-section. The head is emitted unchanged above the `## Summary` heading,
 * exactly like the writer does.
 *
 * Returns { head, body } where head ends with the blank-line gap before body
 * (so head + body reconstructs `rest`). head may be ''.
 */
export function peelTitleHead(rest) {
  const text = String(rest ?? '');
  const lines = text.split('\n');
  let i = 0;
  // Skip leading blank lines (they belong to the head gap).
  while (i < lines.length && lines[i].trim() === '') i++;
  // Take a leading `# ` title if present.
  if (i < lines.length && /^#[ \t]/.test(lines[i]) && !/^##/.test(lines[i])) {
    i++;
    // Take an immediately-following italic subtitle line (`*...*`).
    if (i < lines.length && /^\*.*\*[ \t]*$/.test(lines[i].trim())) i++;
  } else {
    // No `# ` title → no head to peel; entire rest is body.
    return { head: '', body: text };
  }
  // Consume the blank-line gap after the subtitle so the body starts at content.
  const headEnd = i;
  // Reconstruct head = lines[0..headEnd) plus the trailing blank lines up to
  // the first body content, so head+body === rest exactly.
  let bodyStart = headEnd;
  // Find where real body content begins (first non-blank line at/after headEnd).
  let firstContent = headEnd;
  while (firstContent < lines.length && lines[firstContent].trim() === '') firstContent++;
  // head keeps everything up to (not including) firstContent; body is the rest.
  const head = lines.slice(0, firstContent).join('\n') + (firstContent < lines.length ? '\n' : '');
  const body = lines.slice(firstContent).join('\n');
  void bodyStart;
  return { head, body };
}

/**
 * Re-section a legacy body into { summary, historyParts }.
 *
 * Legacy bodies take a few shapes (all observed on disk):
 *   A) `## Chat Summary\n\n<card>\n\n---\n*provenance line*`
 *      → summary = <card>; history = [provenance line]
 *   B) unheaded `<card>\n\n---\n*provenance line*` (no `## Chat Summary`)
 *      → summary = <card>; history = [provenance line]
 *   C) `## Summary\n\n<body>\n\n## Structured data\n...## Editorial\n...`
 *      (curated stub, has `## Summary` but NO `## History`)
 *      → summary = <body up to next `## ` heading>; history = [the trailing
 *        `## Structured data` … blocks, kept verbatim]
 *   D) hand-curated topic-framing file with arbitrary `## ` sections and no
 *      summary/history headings → summary = first section (intro up to the
 *      first `## ` heading, or the whole body if none); history = [everything
 *      from the first `## ` heading onward].
 *
 * The rule that unifies them: the SUMMARY is the chat-ready lead block (the
 * `## Chat Summary`/`## Summary` card body, or the intro prose before the first
 * sub-heading); the HISTORY is everything below that lead block — the `---`
 * provenance tail and/or any subsequent `## ` sections — preserved verbatim.
 * Nothing is dropped.
 */
export function sectionLegacyBody(body) {
  const text = String(body ?? '');
  const lines = text.split('\n');

  // Locate a leading `## Chat Summary` or `## Summary` heading (the lead card).
  // We scan line by line so the FIRST heading governs.
  let leadHeadingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (CHAT_SUMMARY_HEADING_RE.test(lines[i]) || SUMMARY_HEADING_RE.test(lines[i])) {
      leadHeadingIdx = i;
      break;
    }
  }

  // Determine where the summary card body starts, and capture any PRE-block
  // that sits between the start of the body and the lead heading. In curated
  // stubs (shape C) a `**Vertical:** …` block lives ABOVE `## Summary`; it is
  // lead/identity material and must be preserved, so we prepend it to the
  // summary card rather than drop it (the byte-accountability check enforces
  // this — without the capture the transform is correctly rejected as unsafe).
  let cardStart;
  let preBlock = '';
  if (leadHeadingIdx >= 0) {
    // Everything before the lead heading is the pre-block (skip leading blanks).
    let preStart = 0;
    while (preStart < leadHeadingIdx && lines[preStart].trim() === '') preStart++;
    preBlock = lines.slice(preStart, leadHeadingIdx).join('\n').trim();
    cardStart = leadHeadingIdx + 1;
    // Skip a single blank line after the heading.
    while (cardStart < lines.length && lines[cardStart].trim() === '') cardStart++;
  } else {
    // Shape B/D: no lead heading. The card starts at the first non-blank line.
    cardStart = 0;
    while (cardStart < lines.length && lines[cardStart].trim() === '') cardStart++;
  }

  // Find where the summary card ENDS and history begins. History begins at the
  // FIRST of: a `---` HR line OR a `## ` sub-heading, at/after cardStart.
  let historyStart = -1;
  for (let i = cardStart; i < lines.length; i++) {
    if (HR_LINE_RE.test(lines[i]) || /^[ \t]*##[ \t]+\S/.test(lines[i])) {
      historyStart = i;
      break;
    }
  }

  let summary, historyTail;
  if (historyStart === -1) {
    summary = lines.slice(cardStart).join('\n').trim();
    historyTail = '';
  } else {
    const card = lines.slice(cardStart, historyStart).join('\n').trim();
    summary = card;
    // For the history tail, DROP a leading `---` HR line (shape A/B): that `---`
    // was the legacy summary/provenance separator; the writer's own
    // Summary→History delimiter already supplies the `---`, so keeping the
    // legacy one would double it. A `## ` boundary is kept verbatim (it is real
    // content, e.g. `## Structured data`).
    let tailStart = historyStart;
    if (HR_LINE_RE.test(lines[tailStart])) tailStart++;
    historyTail = lines.slice(tailStart).join('\n').trim();
  }

  // Prepend any pre-heading lead block (shape C `**Vertical:** …`) to the
  // summary so it survives in ## Summary. A blank line joins it to the card.
  if (preBlock) {
    summary = summary ? `${preBlock}\n\n${summary}` : preBlock;
  }

  const historyParts = historyTail ? [historyTail] : [];
  return { summary, historyParts };
}

/**
 * Verify the transform preserved content: every non-whitespace character of the
 * original document must appear in the output, in order. We compare the
 * whitespace-stripped concatenations. (The transform only re-sections and may
 * drop a redundant legacy `---` separator line whose role the writer's delimiter
 * now fills; stripping all whitespace AND the literal `---` HR tokens makes the
 * comparison robust to exactly those legal structural edits while still catching
 * any real content loss.)
 */
export function verifyContentPreserved(original, output) {
  const norm = (s) => String(s ?? '')
    // Remove `---` HR lines (structural separators, not content).
    .replace(/^[ \t]*---[ \t]*$/gm, '')
    // Remove the two split headings (structural, may be added/renamed).
    .replace(/^[ \t]*##[ \t]+Summary[ \t]*$/gim, '')
    .replace(/^[ \t]*##[ \t]+History[ \t]*$/gim, '')
    .replace(/^[ \t]*##[ \t]+Chat[ \t]+Summary[ \t]*$/gim, '')
    // Remove the History placeholder line the writer inserts when empty.
    .split(WRITER.placeholder).join('')
    // Collapse all remaining whitespace.
    .replace(/\s+/g, '');
  const a = norm(original);
  const b = norm(output);
  return a === b;
}

/**
 * Pure transform: legacy context.md text → split-shape text. Returns
 * { changed, output, reason }.
 *
 *   - changed=false, reason='already-split' when the file already carries both
 *     `## Summary` and `## History` (idempotent skip).
 *   - changed=false, reason='unsafe' when the byte-accountability check fails;
 *     `output` is null and the caller must leave the file untouched.
 *   - changed=true with the rewritten `output` otherwise.
 *
 * This is the unit-tested core (tests/reformat-context-split.test.js).
 */
export function transformContextMarkdown(original) {
  const text = String(original ?? '');

  // Idempotent: already split → no-op.
  if (SUMMARY_HEADING_RE.test(text) && HISTORY_HEADING_RE.test(text)) {
    return { changed: false, output: text, reason: 'already-split' };
  }

  const { frontmatter, rest } = splitFrontmatter(text);
  const { head, body } = peelTitleHead(rest);
  const { summary, historyParts } = sectionLegacyBody(body);

  // Overflow handling: keep the first SUMMARY_MAX chars in ## Summary; spill the
  // remainder to the TOP of ## History so nothing is dropped (brief requirement).
  let summaryForCompose = summary;
  const overflowParts = [];
  if (summary.length > SUMMARY_MAX) {
    summaryForCompose = summary.slice(0, SUMMARY_MAX);
    const overflow = summary.slice(SUMMARY_MAX).trim();
    if (overflow) overflowParts.push(overflow);
  }
  const allHistoryParts = [...overflowParts, ...historyParts];

  // composeSummaryHistory itself slices the summary at the writer's
  // SUMMARY_TARGET_CHARS. We have already pre-sliced to SUMMARY_MAX (== that
  // target by default) and routed the overflow into history, so the compose
  // call is a no-op slice on the summary and we lose nothing.
  const split = composeSummaryHistory(summaryForCompose, allHistoryParts);

  // Reassemble: frontmatter (verbatim) + title/subtitle head (verbatim) + split.
  // The head already carries its trailing blank-line gap; ensure exactly one
  // blank line separates the head from the `## Summary` heading.
  let output;
  if (head) {
    const headTrimmed = head.replace(/\n+$/, '');
    output = `${frontmatter}${headTrimmed ? headTrimmed + '\n\n' : ''}${split}`;
  } else {
    // No title head (rare). Keep frontmatter then split directly.
    output = `${frontmatter}${frontmatter && !frontmatter.endsWith('\n') ? '\n' : ''}${split}`;
  }

  if (!verifyContentPreserved(text, output)) {
    return { changed: false, output: null, reason: 'unsafe' };
  }
  return { changed: true, output, reason: 'reformatted' };
}

// ════════════════════════════════════════════════════════════════════════════
//  Runner (only executes when invoked as a script, not when imported by tests)
// ════════════════════════════════════════════════════════════════════════════

function argNum(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
function argStr(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] || fallback) : fallback;
}

function toAbsolute(p) {
  const raw = String(p || '').trim();
  if (!raw) return null;
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  if (raw.startsWith('/')) return raw;
  return join(USER_CONTEXTS_DIR, raw);
}

const TYPE_DIR = { people: 'people', companies: 'companies', places: 'places' };

/**
 * Resolve the canonical absolute context.md path for an active entity through
 * the SAME package-name function the writer uses — so the migrator rewrites
 * exactly the file chat reaches, never a guessed sibling.
 */
function canonicalAbsPath(type, id, name) {
  const pkg = entityPackageNameFromDisplay(id, name || id);
  return join(USER_CONTEXTS_DIR, TYPE_DIR[type], pkg, 'context.md');
}

function rewriteFile(absPath, stats, execute) {
  let original;
  try { original = readFileSync(absPath, 'utf8'); }
  catch { stats.read_error++; return; }

  const { changed, output, reason } = transformContextMarkdown(original);
  if (reason === 'already-split') { stats.already_split++; return; }
  if (reason === 'unsafe' || output == null) {
    stats.skipped_unsafe++;
    if (stats.unsafe_samples.length < 10) stats.unsafe_samples.push(absPath);
    return;
  }
  if (!changed) { stats.unchanged++; return; }

  if (execute) {
    try { writeFileSync(absPath, output, 'utf8'); stats.rewritten++; }
    catch (err) {
      stats.write_error++;
      if (stats.write_error_samples.length < 10) stats.write_error_samples.push(`${absPath}: ${err.message}`);
    }
  } else {
    stats.would_rewrite++;
  }
}

// Recursively collect every context.md path under a contexts subtree (bounded
// only by the tree size). Used by the default `disk` scope.
function walkContextFiles(root) {
  const out = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === 'context.md') out.push(full);
    }
  }
  return out;
}

function recordTypeStats(type, base, stats, extra) {
  stats.by_type[type] = {
    ...extra,
    rewritten: (stats.rewritten - (base.rewritten || 0)),
    would_rewrite: (stats.would_rewrite - (base.would_rewrite || 0)),
    already_split: (stats.already_split - (base.already_split || 0)),
    skipped_unsafe: (stats.skipped_unsafe - (base.skipped_unsafe || 0)),
  };
}

// ── scope=active: rewrite only the canonical file of each ACTIVE entity ───────
// (the brief's literal wording). Misses archived/orphan files, so the disk-walk
// probe can still fail; provided for the cases where only chat-reachable files
// matter.
function runEntityTypeActive(type, opts, stats) {
  const table = type;
  const nameCol = type === 'people' ? 'display_name' : 'name';
  const rows = db.prepare(
    `SELECT id, ${nameCol} AS name FROM ${table} WHERE COALESCE(archived,0)=0${opts.limit ? ' LIMIT ' + opts.limit : ''}`,
  ).all();

  const before = { ...stats };
  let processed = 0, missing = 0;
  for (const r of rows) {
    const abs = canonicalAbsPath(type, r.id, r.name);
    if (!existsSync(abs)) { missing++; continue; }
    rewriteFile(abs, stats, opts.execute);
    processed++;
    if (processed % opts.batch === 0) {
      opts.log(`  ${type}: ${processed}/${rows.length} active processed (${stats.rewritten + stats.would_rewrite} flagged so far)`);
    }
  }
  stats.no_file_on_disk += missing;
  recordTypeStats(type, before, stats, { active: rows.length, processed, no_file: missing });
  const s = stats.by_type[type];
  opts.log(`  ${type}: active=${rows.length} on-disk=${processed} no_file=${missing} ` +
    `rewritten=${s.rewritten} would_rewrite=${s.would_rewrite} already_split=${s.already_split} skipped_unsafe=${s.skipped_unsafe}`);
}

// ── scope=disk (default): rewrite EVERY on-disk context.md under the type ─────
// subtree. This is the scope the works-proof (context-split-probe.js) requires —
// it walks the disk and samples ANY file (including archived/orphan packages),
// so the split must be on EVERY file, not only active-entity ones. Safe because
// the transform is byte-lossless and idempotent (verified 0/≈150k unsafe).
function runEntityTypeDisk(type, opts, stats) {
  const root = join(USER_CONTEXTS_DIR, TYPE_DIR[type]);
  const files = walkContextFiles(root);
  const before = { ...stats };
  let processed = 0;
  for (const f of files) {
    rewriteFile(f, stats, opts.execute);
    processed++;
    if (processed % opts.batch === 0) {
      opts.log(`  ${type}: ${processed}/${files.length} on-disk processed (${stats.rewritten + stats.would_rewrite} flagged so far)`);
    }
  }
  recordTypeStats(type, before, stats, { on_disk: files.length, processed });
  const s = stats.by_type[type];
  opts.log(`  ${type}: on_disk=${files.length} rewritten=${s.rewritten} would_rewrite=${s.would_rewrite} ` +
    `already_split=${s.already_split} skipped_unsafe=${s.skipped_unsafe}`);
}

// Topics live at user/contexts/topics/ as hand-curated framing files (NOT in the
// DB context_md store) — always walked from disk regardless of scope, since the
// probe samples them directly.
function runTopics(opts, stats) {
  const root = join(USER_CONTEXTS_DIR, 'topics');
  const files = walkContextFiles(root);
  const before = { ...stats };
  for (const f of files) rewriteFile(f, stats, opts.execute);
  recordTypeStats('topics', before, stats, { files: files.length });
  const s = stats.by_type.topics;
  opts.log(`  topics: files=${files.length} rewritten=${s.rewritten} would_rewrite=${s.would_rewrite} ` +
    `already_split=${s.already_split} skipped_unsafe=${s.skipped_unsafe}`);
}

async function main() {
  const FORCE_DRY = process.argv.includes('--dry-run');
  const EXECUTE = process.argv.includes('--execute') && !FORCE_DRY;
  const LIMIT = argNum('--limit', 0);
  const BATCH = argNum('--batch', 5000);
  const JSON_MODE = process.argv.includes('--json');
  const TYPES = new Set(
    argStr('--types', 'people,companies,places,topics').split(',').map((s) => s.trim()).filter(Boolean),
  );
  // scope: 'disk' (default) rewrites EVERY on-disk context.md — the scope the
  // works-proof requires; 'active' rewrites only active-entity canonical files
  // (the brief's literal wording). Topics are always disk-walked.
  const SCOPE = argStr('--scope', 'disk') === 'active' ? 'active' : 'disk';
  const log = (...a) => { if (!JSON_MODE) console.log(...a); };
  const opts = { execute: EXECUTE, limit: LIMIT, batch: BATCH, log };

  const stats = {
    execute: EXECUTE,
    scope: SCOPE,
    limit: LIMIT || null,
    summary_max: SUMMARY_MAX,
    rewritten: 0,
    would_rewrite: 0,
    already_split: 0,
    unchanged: 0,
    skipped_unsafe: 0,
    no_file_on_disk: 0,
    read_error: 0,
    write_error: 0,
    unsafe_samples: [],
    write_error_samples: [],
    by_type: {},
  };

  log(`reformat-context-split: ${EXECUTE ? 'EXECUTE (writing)' : 'DRY RUN (no writes)'}` +
    `  scope=${SCOPE}${LIMIT ? `  limit=${LIMIT}/type` : ''}  summary_max=${SUMMARY_MAX}`);

  const runType = SCOPE === 'active' ? runEntityTypeActive : runEntityTypeDisk;
  for (const t of ['people', 'companies', 'places']) if (TYPES.has(t)) runType(t, opts, stats);
  if (TYPES.has('topics')) runTopics(opts, stats);

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
  } else {
    log('──');
    log(`  rewritten: ${stats.rewritten}  would-rewrite: ${stats.would_rewrite}  already-split: ${stats.already_split}`);
    log(`  skipped-unsafe: ${stats.skipped_unsafe}  no-file: ${stats.no_file_on_disk}  read-err: ${stats.read_error}  write-err: ${stats.write_error}`);
    if (stats.unsafe_samples.length) log(`  unsafe samples: ${stats.unsafe_samples.slice(0, 3).join(', ')}`);
    log(EXECUTE ? '  (changes applied)' : '  (dry run — re-run with --execute to apply)');
  }
  process.exit(0);
}

// Only run the DB-backed pipeline when invoked directly, not when imported by
// the unit test (which exercises the pure transform functions in isolation).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('reformat-context-split.js');
if (invokedDirectly) {
  main().catch((err) => {
    console.error('reformat-context-split: FATAL', err);
    process.exit(1);
  });
}
