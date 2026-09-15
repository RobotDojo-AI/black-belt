/**
 * lib/legacy-provider-rename.js — carry a legacy second-Asana account slot onto
 * the canonical identifier (st_dd0e19d8 AC20).
 *
 * WHY THIS EXISTS AS DISCOVERY RATHER THAN A LITERAL RENAME. AC20 removes the
 * owner's employer initials from the tracked tree — product code, migrations and
 * tests alike. A migration written the obvious way (`WHERE vendor='<initials>'`)
 * would put them straight back into a tracked file, and the criterion would fail
 * on the very file written to satisfy it. Splitting the literal across a
 * concatenation to dodge the grep would be worse: the initials would still be
 * recoverable and the check would have been gamed rather than met.
 *
 * So the rule is expressed as a CLASS instead of a name: the second Asana slot
 * is any provider identifier under `asana_*` that is not the canonical one. The
 * primary account is plain `asana` — no underscore — so it can never match. That
 * names nothing owner-specific, and it generalises: any install whose second
 * slot carried some other legacy id is carried across by the same code.
 *
 * WHY IT IS NOT A .sql MIGRATION. `accounts.vendor`, `accounts.type` and
 * `accounts.keychain_key` are added by INLINE addColumn() blocks in lib/db.js,
 * which run AFTER applySqlMigrations(). A .sql file naming those columns is
 * compiled before they exist and aborts a fresh install — measured, not
 * predicted: the first draft of this work shipped as 146_*.sql and took every
 * reconciler test down with `no such column: vendor`. Inline is where lib/db.js
 * already documents this class of migration belongs.
 *
 * WHY THE ROWS ARE RENAMED AND NOT DELETED. The `accounts`,
 * `keychain_integrations` and `integration_health` rows are derived state — the
 * reconciler rebuilds them from the registry descriptor at boot and on the
 * 15-minute cadence — so deleting them is correct in steady state and wrong in
 * the gap: until the first reconciler pass the account is simply absent, and the
 * owner sees a disconnected integration and reaches for the reconnect button.
 * AC20's requirement is that he never has to. Renaming makes the row right
 * immediately; the reconciler then agrees with it.
 *
 * WHY THE CONTENT ROWS ARE RE-PREFIXED AND NOT DELETED. The chunks carry real
 * synced content. Deleting them and dual-reading both prefixes until a resync
 * refills them costs the owner his second account's searchable content for as
 * long as the next sync takes, and leaves a permanent `OR` in the read path.
 * Re-prefixing also closes the build-conventions `INSERT OR IGNORE` hazard
 * outright: the deterministic source_id the sync computes after the rename is
 * the one already in the table, so a re-run updates in place instead of writing
 * a second copy under the new prefix. No dual-read window is needed because no
 * window is opened.
 *
 * IDEMPOTENT: after a successful run discovery returns nothing, so a second run
 * is a no-op. Safe to re-run after an interruption.
 *
 * NO OWNER DATA LIVES IN THIS FILE. Product identifiers only.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 */

/** The canonical identifier for a second Asana account slot. */
export const CANONICAL_SECOND_ASANA = 'asana_secondary';
export const CANONICAL_DISPLAY_NAME = 'Asana (Secondary)';
export const CANONICAL_KEYCHAIN_KEY = 'robotdojo-ASANA_PAT_SECONDARY';

/**
 * `asana_%` with `_` escaped so it is a literal underscore rather than SQLite's
 * single-character wildcard. Without the escape this also matches `asanaX`, and
 * an over-broad discovery rule in a migration is how one account becomes two.
 */
const ASANA_UNDERSCORE_LIKE = "asana!_%";
const ESCAPE = "!";

function tableExists(db, name) {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  } catch {
    return false;
  }
}

function safeAll(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

/**
 * Every legacy second-Asana identifier present in this database.
 *
 * Four sources because a half-applied earlier attempt can leave the identifier
 * in some of them and not others, and a discovery that reads only one would
 * declare victory over a database still carrying it elsewhere.
 */
export function discoverLegacyAsanaVendors(db) {
  const found = new Set();
  const add = (v) => {
    const s = String(v || '').trim();
    if (s && s !== CANONICAL_SECOND_ASANA && s.startsWith('asana_')) found.add(s);
  };

  if (tableExists(db, 'accounts')) {
    for (const r of safeAll(db, `SELECT DISTINCT vendor AS v FROM accounts WHERE vendor LIKE ? ESCAPE ?`, ASANA_UNDERSCORE_LIKE, ESCAPE)) add(r.v);
  }
  if (tableExists(db, 'keychain_integrations')) {
    for (const r of safeAll(db, `SELECT DISTINCT provider AS v FROM keychain_integrations WHERE provider LIKE ? ESCAPE ?`, ASANA_UNDERSCORE_LIKE, ESCAPE)) add(r.v);
  }
  if (tableExists(db, 'integration_health')) {
    for (const r of safeAll(db, `SELECT DISTINCT name AS v FROM integration_health WHERE name LIKE ? ESCAPE ?`, ASANA_UNDERSCORE_LIKE, ESCAPE)) add(r.v);
  }
  if (tableExists(db, 'chunks')) {
    // The provider is the source_id prefix before the first colon.
    for (const r of safeAll(
      db,
      `SELECT DISTINCT substr(source_id, 1, instr(source_id, ':') - 1) AS v
         FROM chunks
        WHERE source_id LIKE ? ESCAPE ? AND instr(source_id, ':') > 0`,
      `${ASANA_UNDERSCORE_LIKE}`,
      ESCAPE
    )) add(r.v);
  }
  return [...found].sort();
}

/**
 * Move one legacy identifier onto the canonical one. Returns a per-table count
 * of rows touched, so the caller can report what happened rather than assert it.
 *
 * ORDER MATTERS IN ONE PLACE: the metadata rewrite runs BEFORE the source_id
 * rewrite is irrelevant — both are keyed on the legacy token, not on each other
 * — but the metadata rewrite must be a BARE token replace, not a quoted-value
 * one. The identifier appears in metadata in at least three shapes: as a
 * `provider` value, as a `migrated_provider` value, and embedded inside a
 * `migrated_to` source-id pointer left by an earlier provider migration. A
 * quoted replace fixes the first two and leaves the third pointing at rows this
 * function just re-prefixed — a dangling reference created by the tidy-up.
 */
export function renameLegacyAsanaVendor(db, legacy) {
  const moved = { accounts: 0, keychain_integrations: 0, integration_health: 0, chunks_source_id: 0, chunks_metadata: 0 };
  if (!legacy || legacy === CANONICAL_SECOND_ASANA) return moved;

  if (tableExists(db, 'accounts')) {
    // A canonical row may already exist — a reconciler pass that ran between the
    // code rename and this migration would have created one. It is derived
    // state with no history worth keeping; the legacy row is the one carrying
    // the owner's created_at. Drop the new one so the UPDATE cannot collide.
    db.prepare(
      `DELETE FROM accounts
        WHERE vendor = ?
          AND EXISTS (SELECT 1 FROM accounts WHERE vendor = ?)`
    ).run(CANONICAL_SECOND_ASANA, legacy);
    moved.accounts = db.prepare(
      `UPDATE accounts
          SET id           = ? || substr(id, length(?) + 1),
              vendor       = ?,
              display_name = ?,
              keychain_key = ?,
              updated_at   = datetime('now')
        WHERE vendor = ?`
    ).run(CANONICAL_SECOND_ASANA, legacy, CANONICAL_SECOND_ASANA, CANONICAL_DISPLAY_NAME, CANONICAL_KEYCHAIN_KEY, legacy).changes;
  }

  if (tableExists(db, 'keychain_integrations')) {
    db.prepare(
      `DELETE FROM keychain_integrations
        WHERE provider = ?
          AND EXISTS (SELECT 1 FROM keychain_integrations WHERE provider = ?)`
    ).run(CANONICAL_SECOND_ASANA, legacy);
    moved.keychain_integrations = db.prepare(
      `UPDATE keychain_integrations
          SET provider = ?, display_name = ?, keychain_key = ?
        WHERE provider = ?`
    ).run(CANONICAL_SECOND_ASANA, CANONICAL_DISPLAY_NAME, CANONICAL_KEYCHAIN_KEY, legacy).changes;
  }

  if (tableExists(db, 'integration_health')) {
    // Renamed rather than recreated so last_sync and verified_at survive: a
    // fresh row reads as "never verified", a false negative on the card the
    // owner uses to decide whether the account works.
    db.prepare(
      `DELETE FROM integration_health
        WHERE name = ?
          AND EXISTS (SELECT 1 FROM integration_health WHERE name = ?)`
    ).run(CANONICAL_SECOND_ASANA, legacy);
    moved.integration_health = db.prepare(`UPDATE integration_health SET name = ? WHERE name = ?`)
      .run(CANONICAL_SECOND_ASANA, legacy).changes;
  }

  if (tableExists(db, 'chunks')) {
    moved.chunks_metadata = db.prepare(
      `UPDATE chunks SET metadata = replace(metadata, ?, ?) WHERE metadata LIKE '%' || ? || '%'`
    ).run(legacy, CANONICAL_SECOND_ASANA, legacy).changes;
    moved.chunks_source_id = db.prepare(
      `UPDATE chunks
          SET source_id = ? || substr(source_id, length(?) + 1)
        WHERE source_id LIKE ? || ':%'`
    ).run(CANONICAL_SECOND_ASANA, legacy, legacy).changes;
  }

  return moved;
}

/**
 * The whole migration: discover, then move each. Returns
 * `{ legacy, moved }` — an empty `legacy` list means there was nothing to do,
 * which is the steady state after the first run.
 */
export function migrateLegacySecondAsana(db) {
  const legacy = discoverLegacyAsanaVendors(db);
  const moved = {};
  for (const id of legacy) moved[id] = renameLegacyAsanaVendor(db, id);
  return { legacy, moved };
}
