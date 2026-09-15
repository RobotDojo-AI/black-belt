/**
 * lib/quarantine/index.js — public API.
 *
 * Three exports:
 *   classifyFile(absPath, opts)  — Tier 0 → Tier 1 cascade; returns a decision
 *   executeDecision(decision, opts) — runs the executor with all guards
 *   runOnPath(rootPath, opts)    — orchestrator over a directory or single file
 *
 * All callers (CLI scripts, fixture harness, pre-commit) go through here. The
 * tiered modules under tier-0/, tier-1/, source-finder/, code-mutation/ are
 * implementation details — never imported directly by external callers.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { runTier0 } from './tier-0/index.js';
import { classifyWithHaiku } from './tier-1/index.js';
import { execute as executeImpl, moveToCanonical, quarantineAction, validateDestination } from './executor.js';
import { loadRegistry } from './registry.js';
import { findWriter } from './source-finder/index.js';
import { fixCode, VerifyError } from './code-mutation/index.js';
import { appendEntry } from './manifest.js';
import { ALLOWED_ACTIONS } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function defaultRepoRoot() {
  return join(__dirname, '..', '..');
}

/**
 * classifyFile — decide what to do with a file. Tier 0 first; if no
 * short-circuit, escalate to Tier 1 (Haiku, or injected stub).
 */
export async function classifyFile(absPath, opts = {}) {
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  const registry = opts.registry || loadRegistry({ registryPath: opts.registryPath });
  const home = opts.home || homedir();

  // Compute relPath relative to repo root if applicable. For test fixtures
  // under a tmp dir, callers can pass `inputRoot` and we derive a logical
  // path relative to that root (e.g. "research/2026-04-28-foo.md") so the
  // pending-migration matcher and other prefix-based signals fire correctly.
  let relPath;
  if (absPath.startsWith(repoRoot + '/')) {
    relPath = relative(repoRoot, absPath);
  } else if (absPath.startsWith(home + '/')) {
    relPath = relative(home, absPath);
  } else if (opts.inputRoot && absPath.startsWith(opts.inputRoot + '/')) {
    relPath = relative(opts.inputRoot, absPath);
  } else {
    relPath = absPath;
  }

  // Idempotency short-circuit: if the file is already at a registered canonical
  // destination (under quarantine/ or matches a canonical path), emit a no-op
  // decision. WHY: the orchestrator calls runOnPath on directories that may
  // include already-canonical files. Re-running should produce zero filesystem
  // changes — that's AC #12.
  if (
    relPath.startsWith('quarantine/') ||
    relPath.startsWith('.robotdojo/')
  ) {
    return {
      tier: 'noop',
      action: null,
      file: relPath,
      reason: 'already at canonical destination — no action needed',
      signals: [],
      what_it_is: '', intent: '', confidence: 1, destination: relPath, warnings: [],
    };
  }

  const tier0 = await runTier0(absPath, relPath, { registry, repoRoot });
  if (!tier0.noShortCircuit) {
    return { ...tier0, file: relPath };
  }

  // Tier 1 — Haiku (or injected stub)
  if (opts.haikuClassifier) {
    // Test injection point
    const decision = await opts.haikuClassifier({
      absPath, relPath, signals: tier0.signals, registry, repoRoot,
    });
    return { ...decision, file: relPath, signals: tier0.signals, tier: decision.tier ?? 1 };
  }

  // Real Haiku
  const decision = await classifyWithHaiku({
    absPath, relPath,
    signals: tier0.signals,
    registry,
    repoRoot,
  });
  return { ...decision, file: relPath, signals: tier0.signals };
}

/**
 * executeDecision — drive the executor with the fix-code handler wired in.
 * fix-code uses source-finder + code-mutation; falls back to move-to-canonical
 * on any verify failure.
 */
export async function executeDecision(decision, opts = {}) {
  const repoRoot = opts.repoRoot || defaultRepoRoot();

  const handlers = {
    'fix-code': (dec) => {
      // Locate the writer using source-finder.
      const fileRel = dec.file;
      const fileBase = fileRel.split('/').pop();
      // For a fix-code action, the literal we expect to find is the OLD path
      // (where the file currently is). The destination is the NEW path the
      // writer should emit. We try both the full path and the basename as
      // candidates for the literal.
      const oldLit = fileRel;
      const newLit = dec.destination;

      const w = findWriter({
        oldLiteral: oldLit,
        newLiteral: newLit,
        repoRoot,
        filePath: fileRel,
      });
      if (!w || !w.ok) {
        // Cannot locate writer; fall back to move-to-canonical
        const fallback = moveToCanonical(dec, { repoRoot, ...opts });
        return { ...fallback, fallback: 'move-to-canonical', fallback_reason: w?.reason || 'no writer found' };
      }

      try {
        fixCode({
          writerFile: join(repoRoot, w.writerFile),
          oldLiteral: oldLit,
          newLiteral: newLit,
          repoRoot,
          skipCheckStructure: opts.skipCheckStructure === true,
        });
        // After successful fix-code, move the file too — both code and file land at canonical.
        const moved = moveToCanonical(dec, { repoRoot, ...opts });
        return { ...moved, mutated: w.writerFile };
      } catch (err) {
        if (err instanceof VerifyError) {
          // Revert handled inside fixCode; fall back to move-to-canonical
          const fallback = moveToCanonical(dec, { repoRoot, ...opts });
          return { ...fallback, fallback: 'move-to-canonical', fallback_reason: err.message };
        }
        throw err;
      }
    },
  };

  return executeImpl(decision, { ...opts, repoRoot, handlers });
}

/**
 * runOnPath — orchestrator. Walks a directory (or processes a single file),
 * classifies each, executes if `execute` is true, appends to manifest.
 *
 * Idempotent: a file already at its canonical destination yields a noop.
 */
export async function runOnPath(rootPath, opts = {}) {
  const repoRoot = opts.repoRoot || defaultRepoRoot();
  const manifestPath = opts.manifest || join(repoRoot, 'pipeline', 'quarantine-manifest.jsonl');
  const dryRun = !opts.execute;
  const registry = opts.registry || loadRegistry({ registryPath: opts.registryPath });

  // Resolve rootPath to absolute so that classifyFile can derive a stable
  // repo-relative or home-relative path. Without this, a relative input like
  // "quarantine" causes classifyFile to fall back to the inputRoot branch and
  // strip the "quarantine/" prefix from relPath — which then breaks the
  // idempotency short-circuit ("relPath.startsWith('quarantine/')") and forces
  // every walked file through Tier 1.
  const absRootPath = isAbsolute(rootPath) ? rootPath : resolve(repoRoot, rootPath);
  const files = collectFiles(absRootPath);

  // Determine the logical inputRoot: when the rootPath is a single file, the
  // inputRoot is its parent's parent (so relPath becomes e.g. "research/foo.md").
  // When it's a directory, the rootPath itself is the inputRoot.
  let inputRoot = opts.inputRoot;
  if (!inputRoot) {
    if (existsSync(absRootPath)) {
      const st = statSync(absRootPath);
      if (st.isFile()) {
        // Walk up two levels max to capture a meaningful prefix like "research/"
        inputRoot = dirname(dirname(absRootPath));
      } else if (st.isDirectory()) {
        inputRoot = absRootPath;
      }
    }
  }

  const results = [];
  for (const f of files) {
    let decision;
    try {
      decision = await classifyFile(f, { ...opts, repoRoot, registry, inputRoot });
    } catch (err) {
      results.push({ file: f, error: err.message });
      continue;
    }

    if (!decision || !decision.action) {
      results.push({ file: f, skipped: true, reason: 'no decision' });
      continue;
    }

    let execResult = null;
    let execError = null;
    if (!dryRun) {
      try {
        execResult = await executeDecision(decision, { ...opts, repoRoot, registry });
      } catch (err) {
        execError = err.message;
      }
    }

    // Manifest entry
    const entry = {
      file: decision.file,
      what_it_is: decision.what_it_is || '',
      intent: decision.intent || '',
      action: decision.action,
      destination: decision.destination,
      confidence: decision.confidence ?? 0,
      tier: decision.tier ?? (decision.signals?.length ? 0 : 'unknown'),
      signals: (decision.signals || []).map(s => s.signal_name).filter(Boolean),
      reason: decision.reason || '',
      warnings: decision.warnings || [],
      ts: new Date().toISOString(),
    };
    if (execResult?.fallback) {
      entry.fallback = execResult.fallback;
      entry.fallback_reason = execResult.fallback_reason;
    }
    if (execResult?.result) entry.exec_result = execResult.result;
    if (execError) entry.exec_error = execError;

    if (!dryRun) {
      appendEntry(manifestPath, entry);
    }

    results.push({ file: f, decision, execResult, execError });
  }

  return { results, manifestPath };
}

function collectFiles(rootPath) {
  if (!existsSync(rootPath)) return [];
  const st = statSync(rootPath);
  if (st.isFile()) return [rootPath];
  if (!st.isDirectory()) return [];
  const out = [];
  function walk(d) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  }
  walk(rootPath);
  return out;
}

// Re-exports for callers
export { ALLOWED_ACTIONS, executeImpl as execute, validateDestination };
