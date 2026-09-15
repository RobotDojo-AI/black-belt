#!/usr/bin/env node
/**
 * Classify place subtypes using Haiku. Batches of 20, parallelized 5-wide.
 * Usage: node scripts/classify-places.js [--dry-run] [--limit N]
 */
import { getProvider } from '../lib/llm/index.js';
import config from '../lib/config.js';
import db from '../lib/db.js';
import { modelFor } from '../lib/model-lane.js';

export const INTELLIGENCE_TIER = 'orchestration';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

// Types must match the sidebar PLACE_TYPES keys in apps/network/app.js exactly.
// Taste places (sidebar-visible): restaurant, bar, hotel, concert_hall, museum, library, salon_spa, gym_fitness, wellness, park.
// Utility places (RAG-only, hidden_in_sidebar=1): office, school, hospital, airport, residential, retail, medical, religious.
const TYPES = 'restaurant, bar, hotel, concert_hall, museum, library, salon_spa, gym_fitness, wellness, park, office, school, hospital, airport, residential, retail, medical, religious, other';
const SYSTEM = `Classify each place into exactly one type. Return a JSON array of types in the same order as the input places.
Types: ${TYPES}.
Notes: concert_hall covers theaters, live music, comedy clubs, performing arts. salon_spa covers hair salons, nail salons, spas, beauty. gym_fitness covers gyms, fitness studios, yoga, crossfit. wellness covers meditation, therapy, chiropractor. Use 'other' if unsure.`;

// Utility place types that should be hidden in sidebar (not taste places)
const UTILITY_TYPES = new Set(['office','school','hospital','airport','residential','retail','medical','religious']);
const BATCH_SIZE = 20;
const PARALLEL = 5;


const rows = db.prepare(
  `SELECT id, name FROM places WHERE place_type = 'venue' AND (place_subtype IS NULL OR place_subtype = 'other')${limit ? ` LIMIT ${limit}` : ''}`
).all();

console.info(`${rows.length} places to classify${dryRun ? ' (dry run)' : ''}`);
if (!rows.length) process.exit(0);

const batches = [];
for (let i = 0; i < rows.length; i += BATCH_SIZE) batches.push(rows.slice(i, i + BATCH_SIZE));

const update = db.prepare('UPDATE places SET place_subtype = ?, hidden_in_sidebar = ? WHERE id = ?');
let classified = 0;

async function processBatch(batch) {
  const numbered = batch.map((r, i) => `${i + 1}. ${r.name}`).join('\n');
  const resp = await (await getProvider('anthropic')).complete({
    model: modelFor('fast'), max_tokens: 512, system: SYSTEM,
    messages: [{ role: 'user', content: numbered }],
  });
  const text = resp.content[0].text.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  let types;
  try { types = JSON.parse(text); }
  catch { types = batch.map(() => 'other'); }
  if (!Array.isArray(types)) types = batch.map(() => 'other');
  for (let i = 0; i < batch.length; i++) {
    const type = types[i] || 'other';
    const hidden = UTILITY_TYPES.has(type) ? 1 : 0;
    if (dryRun) { console.info(`  ${batch[i].name} => ${type}${hidden ? ' [hidden]' : ''}`); }
    else { update.run(type, hidden, batch[i].id); }
    classified++;
  }
}

const t0 = Date.now();
for (let i = 0; i < batches.length; i += PARALLEL) {
  await Promise.all(batches.slice(i, i + PARALLEL).map(processBatch));
  console.info(`  ${Math.min((i + PARALLEL) * BATCH_SIZE, rows.length)}/${rows.length}`);
}

console.info(`\nClassified ${classified} places in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const stats = db.prepare(
  "SELECT place_subtype, COUNT(*) as count FROM places WHERE place_type = 'venue' GROUP BY place_subtype ORDER BY count DESC"
).all();
console.info('\nPlace subtype distribution:');
for (const s of stats) console.info(`  ${s.place_subtype}: ${s.count}`);
