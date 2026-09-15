#!/usr/bin/env node
// scripts/check-registry-schema.js — Ajv-strict registry schema gate.
//
// Story st_ae536261. Validates architecture/surfaces.json against
// config/registry-schema.json. Every surface entry must declare:
//   path, class, owner_script, added_at, story_id, max_chars
//
// `additionalProperties: false` on every level prevents drift. `class=manual`
// additionally requires `manual_rationale`. `class=log` is permitted only for
// paths listed in config/log-classes.json (validated post-Ajv since
// JSON-Schema cross-file enums are awkward).
//
// Why a separate gate from check-doc-budget.js:
//   check-doc-budget.js stats files and compares to max_chars at pre-commit.
//   check-registry-schema.js validates the registry's STRUCTURE — that
//   max_chars is even declared. Without the schema gate, an empty registry
//   passes the budget gate trivially. The two gates are orthogonal:
//   schema → structural completeness; budget → measured compliance.
//
// CLI: node scripts/check-registry-schema.js [path-to-registry]
// Default registry path: architecture/surfaces.json
// Exit: 0 on valid, 1 on any violation with field-level error.
//
// Tier: orchestration (no LLM, no DB).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
// ajv-formats is optional — without it, "format": "date-time" is a no-op
// validator (still passes). The required structural fields are what we care
// about, not format compliance.
let addFormats = null;
try {
  ({ default: addFormats } = await import('ajv-formats'));
} catch { /* optional */ }

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const registryPath = process.argv[2]
  ? (process.argv[2].startsWith('/') ? process.argv[2] : resolve(process.cwd(), process.argv[2]))
  : resolve(REPO_ROOT, 'architecture/surfaces.json');
const SCHEMA_PATH = resolve(REPO_ROOT, 'config/registry-schema.json');
const LOG_CLASSES_PATH = resolve(REPO_ROOT, 'config/log-classes.json');

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    process.stderr.write(`[check-registry-schema] failed to read ${path}: ${err.message}\n`);
    process.exit(1);
  }
}

const schema = loadJson(SCHEMA_PATH);
const registry = loadJson(registryPath);
let logClasses;
try {
  logClasses = loadJson(LOG_CLASSES_PATH);
} catch {
  // Best-effort: missing whitelist means no path is allowed class=log.
  logClasses = { paths: [] };
}
const allowedLogPaths = new Set(logClasses.paths || []);

const ajv = new Ajv({
  strict: true,
  // strictRequired triggers errors when an if/then branch references a property
  // that isn't declared at the same level. Our conditional branches reference
  // class via the schema's `definitions/surface/properties` — Ajv can't statically
  // resolve through `if/then`. Drop strictRequired only — keep all other strict checks.
  strictRequired: false,
  allErrors: true,
});
if (addFormats) {
  try { addFormats(ajv); } catch { /* noop */ }
}

const validate = ajv.compile(schema);
const ok = validate(registry);

if (!ok) {
  process.stderr.write(`[check-registry-schema] FAIL — ${validate.errors.length} error(s):\n`);
  for (const e of validate.errors) {
    const where = e.instancePath || '/';
    // For surface-array errors, dig out the offending entry's `path` to make
    // the error grep-friendly during incident response.
    let context = '';
    const match = /^\/surfaces\/(\d+)/.exec(where);
    if (match) {
      const idx = Number(match[1]);
      const entry = registry?.surfaces?.[idx];
      if (entry?.path) context = ` (entry path=${entry.path})`;
    }
    process.stderr.write(
      `  ${where}${context}: ${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}\n`,
    );
  }
  process.exit(1);
}

// Cross-file: class=log paths must be whitelisted in log-classes.json.
const logViolations = (registry.surfaces || []).filter(
  (s) => s.class === 'log' && !allowedLogPaths.has(s.path),
);
if (logViolations.length > 0) {
  process.stderr.write(
    `[check-registry-schema] FAIL — class=log paths not in log-classes.json whitelist:\n`,
  );
  for (const v of logViolations) process.stderr.write(`  ${v.path}\n`);
  process.exit(1);
}

process.stdout.write(
  `[check-registry-schema] ok — ${registry.surfaces.length} entries valid against schema\n`,
);
process.exit(0);
