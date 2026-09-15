#!/usr/bin/env node
/**
 * Extract places from calendar event locations.
 * Run after timeline ingestion to populate places table.
 *
 * Usage: node scripts/extract-places.js
 */
import { extractCalendarPlaces } from '../lib/calendar-extractor.js';
import { recomputePlaceFrequencies } from '../lib/timeline-schema.js';
import db from '../lib/db.js';

const t0 = Date.now();
console.info('=== Place Extraction from Calendar Events ===');

const stats = extractCalendarPlaces();

// Recompute frequencies from actual timeline links (idempotent)
console.info('\nRecomputing frequencies...');
recomputePlaceFrequencies();

// Verify
const byType = db.prepare('SELECT place_type, COUNT(*) as count FROM places GROUP BY place_type').all();
console.info('\nPlaces by type:');
for (const row of byType) {
  console.info(`  ${row.place_type}: ${row.count}`);
}

const topPlaces = db.prepare('SELECT name, place_type, frequency FROM places ORDER BY frequency DESC LIMIT 15').all();
console.info('\nTop 15 places:');
for (const p of topPlaces) {
  console.info(`  ${p.name} (${p.place_type}) — ${p.frequency} events`);
}

console.info(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
