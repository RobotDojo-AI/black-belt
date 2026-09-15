#!/usr/bin/env node
/**
 * second-account-continuity.js — AC20's actual requirement, not its cosmetic
 * half (st_dd0e19d8 Phase 4b).
 *
 * AC20 asks for two things and only one of them is a grep. The grep — the
 * employer initials gone from the tracked tree — is criterion C32 and it passes
 * on deletion alone. This is the other half: the owner's second Asana account
 * keeps working after the rename, with NO reconnection. A rename that clears the
 * grep and quietly disconnects his account has failed the criterion while
 * passing its cheaper test.
 *
 * SEVEN ASSERTIONS, each covering a different way the rename could have half
 * landed, ending with a live call because everything before it is inference:
 *
 *   1. the renamed credential is readable and the old service name is GONE —
 *      copy-verify-delete completed, not just copied;
 *   2. the registry descriptor resolves under the new id and declares the new
 *      keychain key (the source of truth every derived row is rebuilt from);
 *   3. the descriptor's sync job arms with the renamed secret — a descriptor
 *      that resolves but whose job condition reads the old key is a silently
 *      dead integration;
 *   4. the three derived database rows exist under the new id;
 *   5. no row anywhere still carries the old id — a half-migrated database
 *      produces a SECOND account rather than a renamed one;
 *   6. the synced content is still attributable to the account — the chunk count
 *      under the new provider is non-zero, which is what fails if the rows were
 *      deleted instead of re-prefixed;
 *   7. the stored token still authenticates against the vendor. This is the only
 *      assertion that proves "keeps working" rather than "looks consistent".
 *
 * Exit 0 = the second account survived the rename intact.
 *
 * THE OLD IDENTIFIER IS NEVER WRITTEN HERE. Asserting "the employer initials are
 * gone" by grepping for the employer initials would put them back into a tracked
 * file and fail the criterion on the file written to prove it — caught on this
 * probe's own first run. Both stale-state assertions are therefore expressed as
 * CLASS rules instead: no Asana personal-access-token service other than the two
 * canonical ones, and no database row under any legacy second-Asana identifier,
 * discovered by the same rule the migration uses.
 *
 * COMPUTE TIER: Tier 0 — deterministic, no LLM.
 * NO OWNER DATA LIVES IN THIS FILE: product identifiers only. The token is read
 * at runtime and never printed.
 */

import { spawnSync } from 'node:child_process';

const NEW_KEY = 'ASANA_PAT_SECONDARY';
const NEW_ID = 'asana_secondary';
/** The two Asana token services the product declares. Anything else is legacy. */
const CANONICAL_ASANA_SERVICES = new Set(['robotdojo-ASANA_PAT', `robotdojo-${NEW_KEY}`]);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}\n`);
  return ok;
}

/** Read a keychain service directly. Returns '' when the service is absent. */
function keychainRead(service) {
  const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

async function main() {
  process.stdout.write('second-account-continuity: the second Asana account after the AC20 rename\n');

  // 1. The credential moved, and the old name is gone. Env first so the check is
  //    runnable from a criteria subprocess that was handed the value explicitly.
  const token = (process.env[NEW_KEY] || keychainRead(`robotdojo-${NEW_KEY}`) || '').trim();
  check('renamed credential is readable', token.length > 0, token ? `${token.length} chars` : `robotdojo-${NEW_KEY} not found`);

  // The class rule, not a match on the old name: every Asana token service in
  // the keychain must be one of the two the product declares. A legacy service
  // under any name fails this, and the assertion carries no employer initials.
  const { listKeychainServices } = await import('../../lib/keychain.js');
  const asanaServices = listKeychainServices('robotdojo-ASANA_PAT');
  const legacyServices = asanaServices.filter((s) => !CANONICAL_ASANA_SERVICES.has(s));
  check(
    'no legacy Asana token service survives in the keychain',
    legacyServices.length === 0,
    legacyServices.length === 0
      ? `${asanaServices.length} Asana service(s), all canonical`
      : `${legacyServices.length} legacy service(s) still stored`
  );

  // 2 + 3. The descriptor — source of truth for every derived row.
  const { getIntegration } = await import('../../lib/integration-registry.js');
  const descriptor = getIntegration(NEW_ID);
  check('registry descriptor resolves under the new id', !!descriptor, descriptor ? '' : `getIntegration("${NEW_ID}") returned nothing`);
  const declared = descriptor && descriptor.credentials && descriptor.credentials.keychainKeys;
  check(
    'descriptor declares the renamed keychain key',
    Array.isArray(declared) && declared[0] === NEW_KEY,
    Array.isArray(declared) ? declared.join(', ') : 'no keychainKeys'
  );
  const job = descriptor && Array.isArray(descriptor.jobs) ? descriptor.jobs[0] : null;
  const armed = !!(job && typeof job.condition === 'function' && job.condition({ secret: (n) => (n === NEW_KEY ? token : null) }));
  check('sync job arms with the renamed secret', armed, armed ? '' : 'the job condition did not read the renamed key');

  // 4 + 5 + 6. The database.
  const { default: db } = await import('../../lib/db.js');
  const { getAsanaChunkCount } = await import('../../lib/accounts-queries.js');

  const account = db.prepare('SELECT id, vendor, display_name, keychain_key FROM accounts WHERE vendor=?').get(NEW_ID);
  check(
    'accounts row exists under the new id',
    !!account && account.keychain_key === `robotdojo-${NEW_KEY}`,
    account ? `${account.id} → ${account.keychain_key} (${account.display_name})` : 'no row'
  );
  const catalog = db.prepare('SELECT provider, keychain_key FROM keychain_integrations WHERE provider=?').get(NEW_ID);
  check('page-catalog row exists under the new id', !!catalog && catalog.keychain_key === `robotdojo-${NEW_KEY}`, catalog ? catalog.keychain_key : 'no row');
  const health = db.prepare('SELECT name, status FROM integration_health WHERE name=?').get(NEW_ID);
  check('health row exists under the new id', !!health, health ? `status ${health.status}` : 'no row');

  // Same class rule the migration uses, run against the live database: any
  // second-Asana identifier that is not the canonical one is a stray.
  const { discoverLegacyAsanaVendors } = await import('../../lib/legacy-provider-rename.js');
  const strays = discoverLegacyAsanaVendors(db);
  check(
    'no database row carries a legacy second-Asana identifier',
    strays.length === 0,
    strays.length === 0 ? 'accounts, catalog, health and chunks all clear' : `${strays.length} legacy identifier(s) remain`
  );

  const chunkCount = getAsanaChunkCount(db, NEW_ID);
  check(
    'synced content is still attributable to the account',
    chunkCount > 0,
    `${chunkCount} chunk(s) under ${NEW_ID}`
  );

  // 7. The live call. Everything above proves consistency; only this proves the
  //    owner does not have to reconnect.
  let live = false;
  let liveDetail = 'no token to try';
  if (token) {
    try {
      const res = await fetch('https://app.asana.com/api/1.0/users/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      live = res.ok;
      liveDetail = live ? `HTTP ${res.status} — the vendor accepted the renamed credential` : `HTTP ${res.status}`;
    } catch (err) {
      liveDetail = `request failed: ${err.message}`;
    }
  }
  check('the stored token still authenticates with the vendor', live, liveDetail);

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `second-account-continuity: ${results.length - failed.length}/${results.length} PASS\n`
  );
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`second-account-continuity: ${err.stack || err.message}\n`);
    process.exit(2);
  });
