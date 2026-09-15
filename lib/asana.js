/**
 * lib/asana.js — Asana notification helper (ESM)
 *
 * Robot Dojo is open source (White Belt = MIT). This module is intentionally
 * self-contained and dependency-free so anyone forking the codebase can plug in
 * their own Asana workspace by changing three constants and adding their PAT to
 * Keychain. No npm packages — native fetch only (Node 18+).
 *
 * WHY a dedicated module instead of inline calls:
 *   gate.js, maintenance-phases.js, and future scripts all need the same behaviour:
 *   "fire a task to Asana, never crash the caller." Centralising PAT retrieval
 *   and error handling here means callers get fire-and-forget semantics for
 *   free, and the failure log format is consistent across all callers.
 *
 * WHY never throw:
 *   Notification is observability infrastructure. The caller (gate.js, maintenance)
 *   is already doing real work. A notification failure must never propagate —
 *   callers have their own exit conditions and must not be disrupted by a
 *   transient Asana API error, expired PAT, or network timeout.
 *
 * PAT retrieval order:
 *   1. ASANA_PAT env var — set this in test environments or CI.
 *   2. macOS Keychain — canonical service `robotdojo-ASANA_PAT`
 *      This is the production path; LaunchAgents inherit Keychain access from
 *      the login session, so no env var is needed in the plist.
 */

import { readKeychainSecret } from './keychain.js';
import { loadAsanaRoutingConfig } from './asana-routing-config.js';

// ── Constants ────────────────────────────────────────────────────────────────
// PROJECT_GID + WORKSPACE_GID both come from config/asana-routing.json
// (df_e1dcf732 AC9 — one source of truth; NO gid literals in lib/). The tracked
// config ships PLACEHOLDER gids; the owner's real Robot Dojo build board gid
// lives in the gitignored config/asana-routing.user.json override (boards.build).
// On a fresh clone the project is a placeholder — createNotificationTask still
// runs, and Asana's rejection is caught + logged (never thrown), so the module
// degrades gracefully rather than crashing.
const _asanaCfg      = loadAsanaRoutingConfig();
const PROJECT_GID    = _asanaCfg.boards?.build?.project ?? 'REPLACE_WITH_YOUR_ASANA_BUILD_PROJECT_GID';
const WORKSPACE_GID  = _asanaCfg.destinations.default.workspace;
const ASANA_BASE     = 'https://app.asana.com/api/1.0';

// ── PAT retrieval ────────────────────────────────────────────────────────────
// Lazy — only called when createNotificationTask fires. Reads env first so
// tests can override without touching Keychain.
function getPat() {
  if (process.env.ASANA_PAT) return process.env.ASANA_PAT;
  try {
    return readKeychainSecret('ASANA_PAT');
  } catch {
    // Keychain not available (CI, fresh install, SSH session without unlock).
    // Return null — createNotificationTask will log and return null.
    return null;
  }
}

// ── createNotificationTask ────────────────────────────────────────────────────
/**
 * Creates a task in the Miyagi Build Asana project assigned to the PAT owner.
 *
 * @param {string} name  — task title (keep under 200 chars for readability)
 * @param {string} notes — task description; truncated to 2000 chars
 * @returns {Promise<string|null>} GID string on success, null on any error
 *
 * WHY due_on = UTC today:
 *   Operational alerts that fire today are due today — the user marks complete
 *   to ACK. Tomorrow's tasks are tomorrow's problem.
 *
 * WHY notes truncated to 2000 chars:
 *   Asana's rich text field handles large bodies, but stack traces from maintenance
 *   can be extremely long. 2000 chars is enough for the error message and
 *   context without creating a wall of text in the task view.
 */
export async function createNotificationTask(name, notes) {
  const pat = getPat();
  if (!pat) {
    console.error('[asana] notification failed: no PAT available (set ASANA_PAT env or add to Keychain)');
    return null;
  }

  const due_on = new Date().toISOString().slice(0, 10); // UTC today, e.g. "2026-05-08"
  const truncatedNotes = (notes || '').slice(0, 2000);

  const body = {
    data: {
      name,
      notes: truncatedNotes,
      projects: [PROJECT_GID],
      workspace: WORKSPACE_GID,
      assignee: 'me',
      due_on,
    },
  };

  try {
    const res = await fetch(`${ASANA_BASE}/tasks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // WHY log status code: lets the operator distinguish 401 (PAT expired)
      // from 403 (project/workspace not accessible) from 429 (rate limit).
      let detail = `HTTP ${res.status}`;
      try {
        const json = await res.json();
        const msg = json?.errors?.[0]?.message;
        if (msg) detail += ` — ${msg}`;
      } catch { /* response body may not be JSON on network errors */ }
      console.error(`[asana] notification failed: ${detail}`);
      return null;
    }

    const json = await res.json();
    return json?.data?.gid ?? null;

  } catch (e) {
    // fetch() threw — network error, DNS failure, timeout, etc.
    console.error(`[asana] notification failed: ${e.message}`);
    return null;
  }
}
