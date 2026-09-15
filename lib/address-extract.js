/**
 * Address extraction from emails — targeted scan of high-signal sources.
 * Scans shipping confirmations, financial statements, moving companies, leases.
 * Not brute-force: the addresses are explicit in these emails.
 */
import db, { migrate } from './db.js';
import { extractAddresses, normalizeAddress } from './address-patterns.js';

// ── Migration ──
migrate('extracted-addresses-v1', (d) => {
  d.exec(`
    CREATE TABLE extracted_addresses (
      email_id TEXT NOT NULL,
      street TEXT NOT NULL,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      zip TEXT NOT NULL,
      normalized TEXT NOT NULL,
      received_at TEXT NOT NULL,
      PRIMARY KEY (email_id, normalized)
    );
    CREATE INDEX idx_ea_month ON extracted_addresses(received_at);
    CREATE INDEX idx_ea_normalized ON extracted_addresses(normalized);
  `);
});

// High-signal sender domains — shipping, financial, moving, rental
const SCAN_DOMAINS = [
  // Shipping carriers
  'amazon.com', 'ups.com', 'fedex.com', 'usps.gov', 'dhl.com',
  // Financial (statements have mailing address)
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'schwab.com',
  'fidelity.com', 'vanguard.com', 'capitalone.com', 'amex.com', 'americanexpress.com',
  'discover.com', 'sofi.com', 'mercury.com',
  // Moving companies
  'flatrate.com', 'uhaul.com', 'ozmoving.com', 'pods.com', 'eversafemoving.com',
  // Rental / property
  'apartments.com', 'zillow.com', 'realpage.com', 'appfolio.com', 'buildium.com',
  'greystar.com', 'avalon',
];

/**
 * Scan high-signal emails for addresses. Incremental — only scans new emails.
 */
export function scanEmails({ verbose = false } = {}) {
  const log = verbose ? console.log.bind(console) : () => {};
  const last = db.prepare("SELECT MAX(received_at) as d FROM extracted_addresses").get()?.d || '2000-01-01';

  // Build domain filter
  const domainClauses = SCAN_DOMAINS.map(d => `sender_email LIKE '%${d}'`).join(' OR ');
  const sql = `SELECT id, received_at, body_text FROM emails
    WHERE body_text IS NOT NULL AND received_at > ?
    AND (${domainClauses})
    ORDER BY received_at ASC`;

  const rows = db.prepare(sql).all(last);
  log(`Scanning ${rows.length} high-signal emails for addresses...`);

  const insert = db.prepare(`INSERT OR IGNORE INTO extracted_addresses
    (email_id, street, city, state, zip, normalized, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);

  let found = 0;
  const BATCH = 5000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    db.transaction(() => {
      for (const row of batch) {
        for (const addr of extractAddresses(row.body_text)) {
          const norm = normalizeAddress(addr.street, addr.city, addr.state, addr.zip);
          insert.run(row.id, addr.street, addr.city, addr.state, addr.zip, norm, row.received_at);
          found++;
        }
      }
    })();
    if (verbose && i > 0 && i % 50000 === 0) log(`  ...${i} emails processed`);
  }

  log(`Extracted ${found} addresses from ${rows.length} emails.`);
  return { scanned: rows.length, found };
}

/**
 * Aggregate extracted addresses by month. Pick top address per month.
 * Carry forward through gap months.
 */
export function aggregateByMonth() {
  const rows = db.prepare(`
    SELECT substr(received_at, 1, 7) as month, normalized, city, state, zip, COUNT(*) as cnt
    FROM extracted_addresses GROUP BY month, normalized ORDER BY month ASC, cnt DESC
  `).all();

  // Group by month, pick winner
  const byMonth = new Map();
  for (const r of rows) {
    if (!byMonth.has(r.month)) byMonth.set(r.month, r);
    // first row per month is the winner (ORDER BY cnt DESC)
  }

  // Fill gaps by carrying forward
  if (byMonth.size === 0) return [];
  const months = [...byMonth.keys()].sort();
  const first = months[0], last = months[months.length - 1];
  const result = [];
  let prev = null;

  let [y, m] = first.split('-').map(Number);
  const [ey, em] = last.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const winner = byMonth.get(key) || null;
    if (winner) {
      prev = winner;
      result.push({ month: key, address: winner.normalized, city: winner.city, state: winner.state, zip: winner.zip, count: winner.cnt });
    } else if (prev) {
      result.push({ month: key, address: prev.normalized, city: prev.city, state: prev.state, zip: prev.zip, count: 0 });
    }
    m++;
    if (m > 12) { m = 1; y++; }
  }

  return result;
}
