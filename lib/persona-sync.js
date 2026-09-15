/**
 * Persona sync targets — read/write the user_settings row under the
 * 'persona_sync_targets' key. Story st_d9fc573b — AC 11.
 *
 * Schema reuse: user_settings is a (key TEXT, value TEXT, updated_at) k/v
 * table. The value is a JSON-serialised array of {name, enabled}. The
 * shape mirrors the existing identity.targets pattern so future UI can
 * reuse the same icon set.
 *
 * WHY a hardcoded supported-targets list: these are external products
 * (Claude Code, Cursor, ChatGPT, etc.) — adding one is a code change, not
 * a DB row. Keeping the list in source means the icons / labels stay in
 * sync with the rendered UI and there's no possibility of a typo in the
 * DB landing the user with a broken row.
 *
 * The POST endpoint accepts arbitrary `target` IDs so that test code can
 * round-trip without colliding with the canonical list. The GET endpoint
 * union-merges stored state with the supported list — supported targets
 * always appear; unknown stored targets (e.g. test fixtures) also appear.
 */

const SETTINGS_KEY = 'persona_sync_targets';

export const SUPPORTED_TARGETS = [
  { name: 'claude-code', label: 'Claude Code' },
  { name: 'cursor',      label: 'Cursor' },
  { name: 'chatgpt',     label: 'ChatGPT' },
  { name: 'claude-ai',   label: 'Claude.ai' },
  { name: 'gemini',      label: 'Gemini' },
  { name: 'copilot',     label: 'GitHub Copilot' },
];

function readStored(db) {
  try {
    const row = db.prepare('SELECT value FROM user_settings WHERE key=?').get(SETTINGS_KEY);
    if (!row || !row.value) return [];
    const parsed = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(t => t && typeof t.name === 'string');
  } catch {
    return [];
  }
}

function writeStored(db, targets) {
  const stmt = db.prepare(
    "INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    'ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at'
  );
  stmt.run(SETTINGS_KEY, JSON.stringify(targets));
}

/**
 * Return all persona sync targets — the canonical supported set unioned
 * with anything stored in user_settings (covers test fixtures + future
 * targets the user has toggled but the SUPPORTED_TARGETS list hasn't
 * caught up to yet).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ targets: Array<{name:string, label?:string, enabled:boolean}> }}
 */
export function getPersonaSyncTargets(db) {
  const stored = readStored(db);
  const byName = new Map(stored.map(t => [t.name, !!t.enabled]));
  const out = [];
  // Canonical supported set first — preserves rendering order.
  for (const t of SUPPORTED_TARGETS) {
    out.push({ name: t.name, label: t.label, enabled: !!byName.get(t.name) });
    byName.delete(t.name);
  }
  // Anything else stored (custom / test) — appended after the canonical list.
  for (const [name, enabled] of byName) {
    out.push({ name, enabled });
  }
  return { targets: out };
}

/**
 * Persist enabled/disabled for a single target. Initialises the row if
 * missing. Accepts unknown target names — they round-trip through
 * `getPersonaSyncTargets` so tests can use a synthetic ID without polluting
 * the canonical set.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} targetName
 * @param {boolean} enabled
 */
export function setPersonaSyncTarget(db, targetName, enabled) {
  const stored = readStored(db);
  const idx = stored.findIndex(t => t.name === targetName);
  if (idx >= 0) {
    stored[idx].enabled = !!enabled;
  } else {
    stored.push({ name: targetName, enabled: !!enabled });
  }
  writeStored(db, stored);
}
