/**
 * Phase 2d — Email (link only, narrowed to sender-domain allowlist).
 *
 * Directive: not all 350K. Only emails from doc/receipt/reservation
 * senders. Budget target ~15-30K total.
 *
 * But: LINK ONLY — we never create new people from email headers (per CLAUDE.md
 * architectural rule). So the point of scanning email is to associate existing
 * people (contacts/calendar) with more signal. The domain allowlist is what
 * narrows volume, not the creation rule.
 */
import { readFileSync } from 'node:fs';

import db from '../../lib/db.js';
import { getBBModule } from '../../lib/module-loader.js';

/**
 * The owner's own half of the sender-domain allowlist (st_dd0e19d8 AC5).
 *
 * MOVE, NOT REPLACE — the same call the sealed scope already made for the vendor
 * keyword lists, for the same reason. `EMAIL_ALLOWLIST_DOMAINS` is a LIVE
 * classification rule: it decides which of ~350K messages are read at all. A
 * merchant the owner actually buys from is in his entity graph, so the corpus
 * gate flags it; but substituting a placeholder would not redact the merchant,
 * it would stop his receipts from being ingested. So the tracked list keeps the
 * domains that are generic infrastructure (banks, carriers, utilities, the
 * national platforms) and the ones that name a specific merchant relationship
 * move to a file that never ships. On his machine the union equals the previous
 * hardcoded set exactly — which is what makes AC2's identical-behaviour
 * requirement hold by construction.
 *
 * MODULE-RELATIVE, not process.cwd()-relative: this phase runs from the rebuild
 * driver and from cron, and a CWD-dependent classification rule silently
 * changes what gets ingested depending on where the process started.
 */
const USER_DOMAINS_PATH = new URL('../../config/email-allowlist-domains.user.json', import.meta.url);

function loadUserAllowlistDomains() {
  try {
    const cfg = JSON.parse(readFileSync(USER_DOMAINS_PATH, 'utf8'));
    return Array.isArray(cfg.domains) ? cfg.domains : [];
  } catch {
    // Absent on a fresh install, in a published copy, and on anyone else's
    // machine. Designed state, not an error: the tracked generic set stands.
    return [];
  }
}

const wbNormalizeEmail = (s) => (typeof s === 'string' ? s.toLowerCase().trim() : null);
function wbLinkPerson({ email }) {
  const e = email?.toLowerCase().trim();
  if (!e) return null;
  return db.prepare('SELECT person_id as id FROM person_identifiers WHERE type=? AND value=? LIMIT 1').get('email', e) || null;
}

const EMAIL_ALLOWLIST_DOMAINS = new Set([
  // Financial
  'chase.com', 'jpmorgan.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com',
  'schwab.com', 'fidelity.com', 'vanguard.com', 'capitalone.com', 'amex.com',
  'americanexpress.com', 'discover.com', 'sofi.com', 'mercury.com', 'venmo.com',
  'alertsp.chase.com', 'e.chase.com', 'jpmchase.com', 'axosbank.com', 'firstrepublic.com',
  // Tax / government
  'irs.gov', 'ftb.ca.gov', 'usps.gov', 'ssa.gov',
  // Utility
  'pseg.com', 'coned.com', 'nationalgrid.com', 'duke-energy.com', 'pge.com',
  'delmarva.com', 'outreach.delmarva.com', 'comcast.net', 'xfinity.com', 'spectrum.com',
  'verizon.com', 'verizon.net', 'ecrmemail.verizonwireless.com', 'verizonwireless.com',
  // Receipts
  'amazon.com', 'marketplace.amazon.com',
  'instacart.com', 'freshdirect.com',
  'doordash.com', 'ubereats.com', 'grubhub.com',
  'uber.com',
  // Pharmacy / health
  'em.optumrx.com', 'email.optumrx.com', 'rxorder.walgreens.com', 'rx.walgreens.com',
  'pharmacy.cvs.com', 'capsulecares.com', 'amazonpharmacy.com', 'pillpack.com',
  // Reservations
  'opentable.com', 'resy.com', 'tock.com', 'sevenrooms.com',
  // Travel (recorded in travel_events, NOT residence)
  'airbnb.com', 'booking.com', 'hotels.com', 'expedia.com', 'vrbo.com',
  'hyatt.com', 'em.hyatt.com', 't1.hyatt.com',
  ...loadUserAllowlistDomains(),
]);

export function phaseEmail(log) {
  const bb = getBBModule();
  const normalizeEmail = bb?.normalizeEmail ?? wbNormalizeEmail;
  const linkPerson = bb?.linkPerson ?? wbLinkPerson;
  log('\n=== Phase 2d: Email (tier 7 — narrowed to allowlist) ===');

  // Build allowlist SQL clause
  const domainsArr = [...EMAIL_ALLOWLIST_DOMAINS];
  const placeholders = domainsArr.map(() => '?').join(',');

  const senderRows = db.prepare(`
    SELECT DISTINCT sender_email
    FROM emails
    WHERE sender_email LIKE '%@%'
      AND LOWER(substr(sender_email, instr(sender_email,'@')+1)) IN (${placeholders})
  `).all(...domainsArr);

  const totalEmailsQ = db.prepare(`
    SELECT COUNT(*) AS n FROM emails
    WHERE sender_email LIKE '%@%'
      AND LOWER(substr(sender_email, instr(sender_email,'@')+1)) IN (${placeholders})
  `).get(...domainsArr);

  log(`  Allowlist: ${domainsArr.length} domains. Unique senders: ${senderRows.length}. Matching emails: ${totalEmailsQ.n}`);

  const stats = { total: senderRows.length, linked: 0 };
  for (const row of senderRows) {
    const email = normalizeEmail(row.sender_email);
    if (!email) continue;
    const r = linkPerson({ email, source: 'email' });
    if (r) stats.linked++;
  }
  log(`  ${stats.linked}/${stats.total} allowlist senders linked to existing people`);
  return stats;
}
