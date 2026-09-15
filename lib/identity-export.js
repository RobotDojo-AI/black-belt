// lib/identity-export.js — orchestrates identity export across all targets.
//
// Reads the current identity snapshot from the memory log, reads the user's
// enabled target list from user_settings, and dispatches to each adapter.
// Auto-sync targets get their fenced block written to disk. Guided targets
// return copy-paste payloads for the UI to render.
//
// This is the runtime entry point called on:
//   - identity change (chat tool updates a section → auto re-export)
//   - manual "Export now" button in the account page
//   - onboarding completion

import db from './db.js';
import { currentSnapshot } from './identity-log.js';
import { getAdapter, listAdapters, defaultTargetList } from './identity-targets/index.js';
import { contentHashInput } from './identity-targets/render.js';
import { createHash } from 'node:crypto';

const SETTINGS_KEY = 'identity.targets';

/**
 * Read the enabled target list from user_settings. Seeds defaults on first
 * read so the account page always has something to show.
 * @returns {Array<{ id, enabled, path?, installedVersion? }>}
 */
export function getTargets() {
  const row = db.prepare('SELECT value FROM user_settings WHERE key = ?').get(SETTINGS_KEY);
  if (row && row.value) {
    try {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      // fall through to seeding
    }
  }
  const defaults = defaultTargetList();
  writeTargets(defaults);
  return defaults;
}

/**
 * Overwrite the target list in user_settings.
 */
export function writeTargets(targets) {
  if (!Array.isArray(targets)) throw new Error('writeTargets: array required');
  const value = JSON.stringify(targets);
  db.prepare(
    "INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
  ).run(SETTINGS_KEY, value, value);
}

/**
 * Update one target by id. Merges patch into the existing record.
 */
export function updateTarget(id, patch) {
  const targets = getTargets();
  const idx = targets.findIndex((t) => t.id === id);
  if (idx === -1) {
    if (!getAdapter(id)) throw new Error(`unknown adapter: ${id}`);
    targets.push({ id, enabled: false, ...patch });
  } else {
    targets[idx] = { ...targets[idx], ...patch };
  }
  writeTargets(targets);
  return targets[targets.findIndex((t) => t.id === id)];
}

/**
 * Export the current identity to every enabled target.
 *
 * @returns {Promise<{
 *   snapshot: object,
 *   results: Array<{ id, label, kind, ok, action?, path?, payload?, error? }>
 * }>}
 */
export async function exportAll() {
  const snapshot = await currentSnapshot();
  const targets = getTargets();
  const results = [];

  for (const t of targets) {
    if (!t.enabled) continue;
    const adapter = getAdapter(t.id);
    if (!adapter) {
      results.push({ id: t.id, label: t.id, kind: 'unknown', ok: false, error: 'no adapter' });
      continue;
    }
    try {
      const out = await adapter.apply(snapshot, t);
      if (adapter.kind === 'auto-sync') {
        results.push({
          id: adapter.id,
          label: adapter.label,
          kind: 'auto-sync',
          ok: true,
          action: out.action,
          path: out.path,
          bytes: out.bytes,
        });
      } else {
        results.push({
          id: adapter.id,
          label: adapter.label,
          kind: 'guided',
          ok: true,
          payload: out,
        });
      }
    } catch (err) {
      results.push({ id: adapter.id, label: adapter.label, kind: adapter.kind, ok: false, error: err.message });
    }
  }

  return { snapshot, results };
}

/**
 * Export to a single target (by id). Same shape as one result from exportAll.
 */
export async function exportOne(id) {
  const snapshot = await currentSnapshot();
  const adapter = getAdapter(id);
  if (!adapter) throw new Error(`unknown adapter: ${id}`);
  const targets = getTargets();
  const config = targets.find((t) => t.id === id) || { id, enabled: true };

  const out = await adapter.apply(snapshot, config);
  if (adapter.kind === 'auto-sync') {
    return { id, label: adapter.label, kind: 'auto-sync', ok: true, action: out.action, path: out.path, bytes: out.bytes };
  }
  return { id, label: adapter.label, kind: 'guided', ok: true, payload: out };
}

/**
 * Record that a user has installed a specific version of a guided target.
 * Used by the UI to show "version X installed" vs "re-paste to update."
 */
export function markInstalled(id, contentHash) {
  return updateTarget(id, { installedVersion: contentHash, installedAt: new Date().toISOString() });
}

/**
 * Stable hash of the current identity snapshot. Same hash = same content,
 * same content = no need to prompt the user to re-paste into guided targets.
 */
export function snapshotHash(snapshot) {
  return createHash('sha256').update(contentHashInput(snapshot)).digest('hex').slice(0, 12);
}

/**
 * Combined view for the account page. Returns adapters + current config +
 * computed "needs re-install" flag for guided targets.
 */
export async function statusForUi() {
  const snapshot = await currentSnapshot();
  const hash = snapshotHash(snapshot);
  const targets = getTargets();
  const adapters = listAdapters();
  const byId = new Map(targets.map((t) => [t.id, t]));

  return {
    snapshot,
    currentHash: hash,
    adapters: adapters.map((a) => {
      const t = byId.get(a.id) || { id: a.id, enabled: false };
      const needsInstall = a.kind === 'guided' && t.enabled && t.installedVersion !== hash;
      return { ...a, ...t, needsInstall };
    }),
  };
}
