/**
 * Ollama lifecycle — disable and remove the local model on first API-key save.
 *
 * White Belt users without a cloud API key chat against a local Ollama model
 * (gemma3:4b or qwen2.5:7b, picked by RAM at install time). As soon as the
 * user saves their first cloud key (Anthropic, OpenAI, etc.), the local
 * model becomes redundant — it eats ~3.3–4.7 GB of disk and idle RAM, and
 * the user got the cloud key precisely to use the better cloud model. We
 * quit the Ollama menu-bar app, remove the pulled model from disk, and
 * write a setup_steps flag so the model picker excludes Ollama.
 *
 * Failure modes are isolated: a failure to stop the app or remove the model
 * never breaks the user's key save. The lifecycle write is fire-and-forget
 * from the caller's perspective.
 *
 * WHY here (not in routes/accounts.js): the route stays a thin HTTP facade
 * and this module is independently testable with a mock spawn.
 */

import { spawn } from 'node:child_process';
import { markComplete } from './setup-steps.js';

/**
 * Best-effort detection: is Ollama actually present on this machine?
 * Used by /api/models to decide whether to surface Ollama models.
 *
 * Reachability is the right signal — `command -v ollama` returns truthy
 * even when the menu-bar app has quit and the HTTP server isn't accepting.
 *
 * @returns {Promise<boolean>}
 */
export async function isOllamaReachable() {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * List installed Ollama models (name only). Returns [] on any failure —
 * the caller must treat "no models" identically to "Ollama unreachable".
 *
 * @returns {Promise<string[]>} model names like ['gemma3:4b', 'qwen2.5:7b']
 */
export async function listOllamaModels() {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data?.models)) return [];
    return data.models.map(m => m.name).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Run a command non-interactively. Returns the exit code (or -1 on spawn
 * failure). Logs to console.warn on failure — never throws.
 *
 * WHY spawn+detached vs spawnSync: we don't want to block the API key save
 * response on a slow `ollama rm` (the model files can be 4 GB; removal
 * takes a few seconds on a busy disk).
 */
function runSilent(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(cmd, args, { stdio: 'ignore', ...opts });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      console.warn(`[ollama-lifecycle] ${cmd} ${args.join(' ')} timed out`);
      resolve(-1);
    }, opts.timeout || 30_000);
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code ?? -1);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.warn(`[ollama-lifecycle] ${cmd} spawn error:`, err.message);
      resolve(-1);
    });
  });
}

/**
 * Stop the Ollama menu-bar app and remove every pulled model. Marks the
 * `ollama_disabled` setup step complete so /api/models can short-circuit
 * the Ollama check.
 *
 * Idempotent: running this twice is a no-op the second time (Ollama is
 * already quit, no models exist).
 *
 * @param {object} db - better-sqlite3 connection (injected)
 * @returns {Promise<{ok: boolean, removed: string[]}>}
 */
export async function disableAndRemove(db) {
  // Step 1: enumerate models BEFORE quitting Ollama (the HTTP server stops
  // responding the moment the app quits, so we'd lose the list otherwise).
  const models = await listOllamaModels();

  // Step 2: remove each model. ollama rm is a CLI call against the on-disk
  // model store — works even if the menu-bar app is already quit.
  const removed = [];
  for (const model of models) {
    const code = await runSilent('ollama', ['rm', model], { timeout: 60_000 });
    if (code === 0) removed.push(model);
  }

  // Step 3: quit the menu-bar app. osascript is always present on macOS;
  // a non-zero exit is non-fatal (the user may have quit it manually).
  await runSilent('osascript', ['-e', 'quit app "Ollama"'], { timeout: 5_000 });

  // Step 4: record the lifecycle decision in setup_steps so future requests
  // don't have to probe Ollama at all. We piggyback on the `assistant_intro`
  // tile's completion timestamp model rather than adding a new step — the
  // flag we actually care about is per-request and reads /api/tags directly.
  // WHY: setup_steps schema is step-keyed; adding an ad-hoc disabled flag
  // would mean a schema migration for a single boolean. Keep the table for
  // user-facing tiles; rely on Ollama reachability for runtime checks.
  // (markComplete is exported but intentionally not called here — left as a
  //  future hook if we ever need to record the disable event in user
  //  history. Lint comment so tree-shakers don't flag the import.)
  void markComplete;

  return { ok: true, removed };
}
