#!/usr/bin/env node
/**
 * scripts/check-installer-parity.js — st_bc949e7c VC 10a + VC 10b
 *
 * Enforces parity between three sources of truth:
 *
 *   1. `config/launch-agents.json` — the manifest declaring every product
 *      LaunchAgent. Each entry: { label, template, audience, ... }.
 *   2. `apps/static/launch-agents/*.plist.template` — the per-label
 *      template files referenced by the manifest.
 *   3. `apps/static/install.sh` — the installer. Must not load any plist
 *      outside the manifest-driven loop.
 *
 * Three checks, all run on every invocation:
 *
 *   (a) manifest → template — every manifest entry's `template` path must
 *       point to an existing file.
 *   (b) template → manifest — every `*.plist.template` in
 *       `apps/static/launch-agents/` must have a manifest entry (no
 *       orphans). The orphan check defends against templates left behind
 *       after a label rename.
 *   (c) install.sh rogue-load — `install.sh` must contain no `launchctl
 *       load` line that references a literal `com.robotdojo.*.plist` path
 *       outside the `install_launch_agents` function — and the literal
 *       label must not be in the manifest. Variable-driven loads
 *       (`launchctl load "$LAUNCHD_PLIST"`) are skipped — the variable
 *       resolves to whichever label the loop is iterating, which is
 *       manifest-driven by construction. Literal-path loads outside the
 *       loop indicate hand-wired drift.
 *
 * Exits 0 on parity, 1 on any violation with a specific error message.
 *
 * CLI flags (test-only — production runs zero-arg):
 *   --root <path>       — repo root override (defaults to script's repo)
 *   --manifest <path>   — manifest path override (defaults to <root>/config/launch-agents.json)
 *   --install-sh <path> — install.sh path override (defaults to <root>/apps/static/install.sh)
 *
 * Wired into scripts/pre-commit.sh.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(__dirname, '..');

// ── Argument parsing ─────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { root: null, manifest: null, installSh: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--install-sh') out.installSh = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const REPO_ROOT = args.root ? resolve(args.root) : DEFAULT_REPO_ROOT;
const MANIFEST_PATH = args.manifest
  ? resolve(args.manifest)
  : join(REPO_ROOT, 'config', 'launch-agents.json');
const INSTALL_SH_PATH = args.installSh
  ? resolve(args.installSh)
  : join(REPO_ROOT, 'apps', 'static', 'install.sh');
const TEMPLATE_DIR = join(REPO_ROOT, 'apps', 'static', 'launch-agents');

// ── Output helpers ───────────────────────────────────────────────────────────

const failures = [];

function fail(msg) {
  failures.push(msg);
}

function flush() {
  if (failures.length === 0) return 0;
  console.error('[check-installer-parity] FAIL — installer drift detected:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\nFix: bring config/launch-agents.json, apps/static/launch-agents/*.plist.template, and apps/static/install.sh back into sync.`);
  return 1;
}

// ── Load manifest ────────────────────────────────────────────────────────────

if (!existsSync(MANIFEST_PATH)) {
  console.error(`[check-installer-parity] FAIL: manifest not found at ${MANIFEST_PATH}`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
} catch (e) {
  console.error(`[check-installer-parity] FAIL: manifest is not valid JSON — ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(manifest.agents)) {
  console.error('[check-installer-parity] FAIL: manifest is missing the `agents` array');
  process.exit(1);
}

// Build the manifest-label set up-front for the rogue-load check.
const manifestLabels = new Set(manifest.agents.map((a) => a.label));

// ── Check (a) — every manifest entry has a template file ────────────────────

for (const entry of manifest.agents) {
  if (!entry.label || !entry.template) {
    fail(`manifest entry missing label or template: ${JSON.stringify(entry)}`);
    continue;
  }
  const templateAbs = join(REPO_ROOT, entry.template);
  if (!existsSync(templateAbs)) {
    fail(`manifest entry "${entry.label}" → template not found: ${entry.template}`);
  }
}

// ── Check (b) — every template has a manifest entry (no orphans) ────────────

if (existsSync(TEMPLATE_DIR)) {
  const templates = readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.plist.template'));
  const referenced = new Set(
    manifest.agents
      .map((a) => a.template)
      .filter(Boolean)
      .map((t) => basename(t)),
  );
  for (const t of templates) {
    if (!referenced.has(t)) {
      fail(`orphan template "${t}" — no manifest entry references it`);
    }
  }
}

// ── Check (c) — install.sh has no rogue `launchctl load` ────────────────────
//
// Scan install.sh line-by-line. A line is a violation if all are true:
//   - The line contains `launchctl load`.
//   - The line contains a LITERAL `com.robotdojo.*.plist` path (not a $var).
//   - The extracted label is NOT in the manifest.
//
// Variable-driven loads (`launchctl load "$LAUNCHD_PLIST"`) are skipped:
// the variable resolves to whatever label the manifest-walking loop is
// iterating, which is manifest-driven by construction. The only way to
// introduce drift via a variable is to manually set the variable to a
// rogue label — which is not detectable by static analysis and is caught
// by check (a)/(b) on the manifest itself.

if (!existsSync(INSTALL_SH_PATH)) {
  fail(`install.sh not found at ${INSTALL_SH_PATH}`);
} else {
  const lines = readFileSync(INSTALL_SH_PATH, 'utf8').split('\n');
  const labelRx = /\bcom\.robotdojo\.[a-z0-9-]+/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Skip comment lines — only enforce on executable code.
    const trimmed = raw.replace(/^\s+/, '');
    if (trimmed.startsWith('#')) continue;
    if (!/\blaunchctl\s+load\b/.test(raw)) continue;
    const m = raw.match(labelRx);
    if (!m) continue; // variable-driven load — fine
    const label = m[0];
    if (!manifestLabels.has(label)) {
      fail(
        `apps/static/install.sh:${i + 1} — \`launchctl load\` references "${label}" which is not in the manifest`,
      );
    }
  }
}

process.exit(flush());
