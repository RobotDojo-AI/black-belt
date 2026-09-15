#!/usr/bin/env node
// scripts/check-doc-budget-raise.js — st_862d73d1 AC4.
//
// A doc-budget RAISE is telemetry that a file is taking on too much — it must
// not be an agent's silent default. This gate BLOCKS any increase of a surface's
// `max_chars` in architecture/surfaces.json (staged vs HEAD) unless a matching
// owner-countersigned approval record exists, mirroring the root-lock approval
// pattern. Decreases and new surfaces are always allowed (a decrease tightens
// the budget; a new surface is not a raise). Every applied raise appends a row
// to the telemetry log so a rising budget is visible, not routine.
//
// Approval record (~/.robotdojo/doc-budget-approvals.json):
//   { "approvals": [ { "story_id", "owner_quote", "raises": { "<path>": <new_max_chars_int> } } ] }
// A raise of <path> to N is approved iff some approval entry has a non-empty
// owner_quote, a story_id, and raises[<path>] === N. The agent cannot fabricate
// the owner_quote — it is the owner's verbatim countersign (root-lock pattern).
//
// Telemetry (~/.robotdojo/doc-budget-raises.log, JSONL):
//   { ts, path, old_max, new_max, story_id }
//
// CLI: node scripts/check-doc-budget-raise.js
// Exit: 0 when no unapproved raise is staged; 1 on any unapproved raise.
//
// Tier: orchestration.
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.ROBOTDOJO_REPO_ROOT
  ? resolve(process.env.ROBOTDOJO_REPO_ROOT)
  : resolve(__dirname, '..');

const SURFACES_REL = 'architecture/surfaces.json';

function approvalsPath() {
  // Lives under ~/.robotdojo/ (plaintext-allowed per build conventions), parallel
  // to root-lock-approvals.json so the two never collide.
  return join(homedir(), '.robotdojo', 'doc-budget-approvals.json');
}

function telemetryPath() {
  return join(homedir(), '.robotdojo', 'doc-budget-raises.log');
}

// Parse a surfaces.json blob → Map<path, max_chars>. Tolerant of array or
// {surfaces:[...]} shape; ignores entries without a numeric max_chars.
function surfaceBudgets(text) {
  const map = new Map();
  if (!text) return map;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return map; }
  const surfaces = Array.isArray(parsed) ? parsed : (parsed.surfaces || []);
  for (const s of surfaces) {
    if (s && typeof s.path === 'string' && typeof s.max_chars === 'number') {
      map.set(s.path, s.max_chars);
    }
  }
  return map;
}

// Read a git blob (staged index `:<file>` or `HEAD:<file>`). Returns '' when
// the blob does not exist (new surfaces file, or no HEAD yet).
function gitBlob(ref) {
  const exists = spawnSync('git', ['-C', REPO_ROOT, 'cat-file', '-e', ref]);
  if (exists.status !== 0) return '';
  const r = spawnSync('git', ['-C', REPO_ROOT, 'show', ref], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) return '';
  return r.stdout || '';
}

function loadApprovals() {
  const p = approvalsPath();
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (parsed.approvals || []);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Is a raise of <path> to <newMax> approved? Requires a non-empty owner_quote +
// story_id and raises[<path>] === newMax.
function approvalFor(approvals, path, newMax) {
  for (const a of approvals) {
    if (!a || !a.story_id) continue;
    if (!a.owner_quote || String(a.owner_quote).trim() === '') continue;
    if (a.raises && a.raises[path] === newMax) return a;
  }
  return null;
}

function recordTelemetry(rows) {
  if (!rows.length) return;
  const p = telemetryPath();
  mkdirSync(dirname(p), { recursive: true });
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const r of rows) {
    appendFileSync(p, JSON.stringify({ ts, ...r }) + '\n');
  }
}

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

function main() {
  // Baseline ref: HEAD locally (pre-commit), or an explicit --base <ref> in CI
  // so a PR's surfaces.json is compared against the merge base, not its own head.
  const baseRef = argVal('--base') || 'HEAD';
  const headText = gitBlob(`${baseRef}:${SURFACES_REL}`);
  // Compare against the STAGED surfaces.json (pre-commit stages first). If not
  // staged, fall back to the working-tree file so a direct edit is also caught.
  let stagedText = gitBlob(`:${SURFACES_REL}`);
  if (!stagedText) {
    const abs = isAbsolute(SURFACES_REL) ? SURFACES_REL : join(REPO_ROOT, SURFACES_REL);
    if (existsSync(abs)) stagedText = readFileSync(abs, 'utf8');
  }

  // No baseline (fresh repo / base ref absent) → nothing to compare against; allow.
  if (!headText) {
    process.exit(0);
  }

  const head = surfaceBudgets(headText);
  const staged = surfaceBudgets(stagedText);
  const approvals = loadApprovals();

  const unapproved = [];
  const approvedRaises = [];
  for (const [path, newMax] of staged) {
    if (!head.has(path)) continue; // new surface — not a raise
    const oldMax = head.get(path);
    if (newMax <= oldMax) continue; // decrease or unchanged — always allowed
    const approval = approvalFor(approvals, path, newMax);
    if (approval) {
      approvedRaises.push({ path, old_max: oldMax, new_max: newMax, story_id: approval.story_id });
    } else {
      unapproved.push({ path, oldMax, newMax });
    }
  }

  if (unapproved.length) {
    process.stderr.write('\n[check-doc-budget-raise] BLOCKED — unapproved doc-budget raise(s):\n');
    for (const u of unapproved) {
      process.stderr.write(`  - ${u.path}: ${u.oldMax} → ${u.newMax} (increase)\n`);
    }
    process.stderr.write(
      '\nRaising a budget is telemetry that a file is taking on too much — only the owner raises it,\n' +
      'deliberately, with a recorded countersign. Add an approval to ~/.robotdojo/doc-budget-approvals.json\n' +
      'keyed { story_id, owner_quote (the owner\'s verbatim words), raises: { "<path>": <new_max_chars> } },\n' +
      'or distill the doc back under its current budget (a decrease needs no approval).\n',
    );
    process.exit(1);
  }

  // All raises (if any) are approved — log telemetry and pass.
  recordTelemetry(approvedRaises);
  if (approvedRaises.length) {
    process.stdout.write(`[check-doc-budget-raise] ${approvedRaises.length} approved raise(s) recorded to telemetry.\n`);
  }
  process.exit(0);
}

main();
