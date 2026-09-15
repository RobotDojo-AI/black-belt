/**
 * Phase 6 — Address timeline (canonical-first, ~5 residences).
 *
 * Algorithm ("what would a human do?"):
 *   1. Scan `extracted_addresses` (already built; rescan if empty)
 *   2. Filter to addresses with signal distributed across multiple days
 *      (filters out Amazon warehouse ship-from addresses that all hit on
 *      the same day, leaving only actual delivery addresses)
 *   3. Merge consecutive months into periods
 *   4. Output ~5 canonical residences for the owner
 */
import db from '../../lib/db.js';
import { ownerPersonId, ownerDisplayNameMatch } from '../../lib/identity.js';

export async function buildSimpleAddressTimeline(log) {
  log('\n=== Phase 6: Address timeline (canonical) ===');

  // Ensure extracted_addresses is populated (should already be from prior runs)
  const exCount = db.prepare('SELECT COUNT(*) AS n FROM extracted_addresses').get().n;
  log(`  extracted_addresses: ${exCount} rows`);

  // If empty, rescan using the legacy scanner. For now, it's populated.
  if (exCount === 0) {
    const { scanEmails } = await import('../../lib/address-extract.js');
    scanEmails({ verbose: true });
  }

  // Resolve canonical owner person_id from ~/.robotdojo/identity.json.
  // Prefer explicit owner_person_id; fall back to display_name_match.
  let owner = null;
  const _pid = ownerPersonId();
  if (_pid) {
    owner = db.prepare(`SELECT id FROM people WHERE id = ? AND archived = 0`).get(_pid);
  } else {
    const nameMatch = ownerDisplayNameMatch();
    if (nameMatch) {
      owner = db.prepare(`
        SELECT id FROM people
        WHERE LOWER(display_name) LIKE ?
          AND archived = 0
        ORDER BY interaction_count DESC LIMIT 1
      `).get(`%${nameMatch}%`);
    }
  }
  if (!owner) {
    log('  WARN: owner person not resolved (check ~/.robotdojo/identity.json). Skipping address timeline.');
    return { rows: [], owner: null };
  }

  // Get all address clusters, filtered to residential candidates:
  //   - distinct_days >= 2 (rules out Amazon ship-from which hits all at once)
  //   - total_hits >= 3 (filters one-off noise)
  const clusters = db.prepare(`
    SELECT normalized,
           city, state, zip,
           COUNT(*) AS total_hits,
           COUNT(DISTINCT substr(received_at, 1, 10)) AS distinct_days,
           MIN(received_at) AS first_seen,
           MAX(received_at) AS last_seen
    FROM extracted_addresses
    GROUP BY normalized
    HAVING total_hits >= 3
      AND distinct_days >= 2
    ORDER BY first_seen ASC
  `).all();

  log(`  Residential candidates (≥3 hits, ≥2 distinct days): ${clusters.length}`);

  // Additional filter: drop obvious commercial addresses
  const COMMERCIAL_CITIES = new Set([
    'MEMPHIS', 'ABERDEEN', 'ORLANDO', 'THORNTON', 'ROMULUS', 'SHELBY TOWNSHIP',
    'WEST DEPTFORD', 'SWEDESBORO', 'PARSIPPANY', 'CLEARBROOK', 'REDLANDS',
    'YONKERS', 'EASTVALE', 'LAS VEGAS', 'JACKSONVILLE', 'INDIANAPOLIS',
    'HERNDON', 'MINOOKA', 'KATONAH',
  ]);
  const filtered = clusters.filter(c => {
    const city = (c.city || '').toUpperCase();
    // Memphis = Amazon HQ. Most of those others are Amazon FCs/warehouses.
    // Residences should be the user's actual address cluster.
    return !COMMERCIAL_CITIES.has(city);
  });
  log(`  After commercial-city filter: ${filtered.length}`);

  // Build address_timeline rows
  const insert = db.prepare(`
    INSERT OR REPLACE INTO address_timeline
      (person_id, address_normalized, address_json, month_start, residency_type,
       dominant_source, source_count, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const rows = [];
  db.transaction(() => {
    // Consolidate to ONE row per canonical address (period = first_seen to last_seen)
    for (const c of filtered) {
      const addr = {
        formatted: c.normalized,
        city: c.city, region: c.state, postal_code: c.zip,
        country: 'US',
      };
      const monthStart = (c.first_seen || '').slice(0, 7) + '-01';
      insert.run(
        owner.id,
        c.normalized,
        JSON.stringify(addr),
        monthStart,
        'primary_residence',
        'receipt',              // extracted from email delivery/receipt lines
        c.total_hits,
        Math.min(0.95, 0.5 + c.distinct_days * 0.05),
      );
      rows.push({
        address: c.normalized,
        city: c.city, state: c.state, zip: c.zip,
        first_seen: c.first_seen?.slice(0, 10),
        last_seen: c.last_seen?.slice(0, 10),
        hits: c.total_hits,
        days: c.distinct_days,
        source: 'email_delivery_receipt',
        confidence: Math.min(0.95, 0.5 + c.distinct_days * 0.05),
      });
    }
  })();

  log(`  Wrote ${rows.length} canonical residence rows to address_timeline for owner (${owner.id})`);
  for (const r of rows) {
    log(`    ${r.first_seen} → ${r.last_seen}   ${r.address.substring(0, 60)} (${r.hits} hits / ${r.days} days)`);
  }

  return { rows, owner };
}
