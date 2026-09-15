#!/usr/bin/env node
/**
 * import-linkedin-connections.js — enrich people from a LinkedIn connections
 * export (st_f1a40461), NOT web scraping.
 *
 * LinkedIn's "Connections.csv" has: First Name, Last Name, URL, Email Address,
 * Company, Position, Connected On (after a 3-line preamble). This is the owner's
 * own authoritative view of who someone is and what they do — far better than a
 * web scrape. We match each connection to an existing person and populate
 * linkedin_url + linkedin_title (which the context bio reads as `data.title`).
 *
 * MATCHING IS CONSERVATIVE: link only when the connection's URL already matches,
 * OR exactly ONE active person has that normalized full name (no ambiguous merges
 * across same-name people). Idempotent.
 *
 * Usage: node scripts/import-linkedin-connections.js <connections.csv>
 */
import db from '../lib/db.js';
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: import-linkedin-connections.js <csv>'); process.exit(1); }

// Minimal RFC-4180-ish CSV line parser (handles quoted fields with commas/quotes).
function parseLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const headerIdx = lines.findIndex((l) => l.startsWith('First Name,Last Name,'));
if (headerIdx < 0) { console.error('no LinkedIn connections header found'); process.exit(1); }

const byUrl = db.prepare('SELECT id FROM people WHERE linkedin_url = ? LIMIT 1');
const byName = db.prepare('SELECT id FROM people WHERE archived = 0 AND lower(trim(display_name)) = ?');
const upd = db.prepare('UPDATE people SET linkedin_url = COALESCE(?, linkedin_url), linkedin_title = COALESCE(?, linkedin_title) WHERE id = ?');

let matched = 0, ambiguous = 0, nomatch = 0, total = 0;
const tx = db.transaction((rows) => {
  for (const cols of rows) {
    const [first, last, url, , , position] = cols;
    const full = norm(`${first} ${last}`);
    if (!full || full.split(' ').length < 2) { nomatch++; continue; }
    total++;
    let personId = null;
    if (url) personId = byUrl.get(url)?.id || null;
    if (!personId) {
      const hits = byName.all(full);
      if (hits.length === 1) personId = hits[0].id;
      else if (hits.length > 1) { ambiguous++; continue; }
      else { nomatch++; continue; }
    }
    upd.run(url || null, position || null, personId);
    matched++;
  }
});
const rows = lines.slice(headerIdx + 1).filter(Boolean).map(parseLine).filter((c) => c.length >= 6);
tx(rows);
console.log(`[linkedin-import] ${rows.length} connections | matched=${matched} ambiguous-skipped=${ambiguous} no-match=${nomatch}`);
