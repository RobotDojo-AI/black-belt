#!/usr/bin/env node
/**
 * Enrich places: noise filter, city intelligence, sub-category classification.
 * Usage: node scripts/enrich-places.js [--dry-run] [--limit N]
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

// --- 1. Noise filter ---
const NOISE_TYPES = ['office', 'residential', 'airport', 'other'];
const noiseCount = db.prepare(
  `SELECT COUNT(*) as n FROM places WHERE place_subtype IN (${NOISE_TYPES.map(() => '?').join(',')}) AND useful != 0`
).get(...NOISE_TYPES).n;

const orphanCount = db.prepare(
  `SELECT COUNT(*) as n FROM places WHERE frequency = 1 AND parent_place_id IS NULL AND place_type = 'venue' AND useful != 0`
).get().n;

console.info(`Noise filter: ${noiseCount} noise places + ${orphanCount} one-off orphans`);
if (!dryRun) {
  db.prepare(`UPDATE places SET useful = 0 WHERE place_subtype IN (${NOISE_TYPES.map(() => '?').join(',')})`).run(...NOISE_TYPES);
  db.prepare(`UPDATE places SET useful = 0 WHERE frequency = 1 AND parent_place_id IS NULL AND place_type = 'venue'`).run();
  // Ensure good places stay useful = 1
  db.prepare(`UPDATE places SET useful = 1 WHERE place_subtype NOT IN (${NOISE_TYPES.map(() => '?').join(',')}) AND frequency > 1 AND useful = 0`).run(...NOISE_TYPES);
}

// --- 2. City intelligence ---
// Batch: total_visits per city from child place frequencies
db.exec(`UPDATE places SET total_visits = COALESCE((
  SELECT SUM(p2.frequency) FROM places p2 WHERE p2.parent_place_id = places.id
), 0) WHERE place_type = 'city'`);

// Batch: years_lived — get all city events in one query, group in JS
const cityEvents = db.prepare(`
  SELECT p.parent_place_id as city_id, strftime('%Y', te.event_date) as yr
  FROM timeline_events te
  JOIN timeline_event_entities tee ON tee.event_id = te.id
  JOIN places p ON CAST(tee.entity_id AS INTEGER) = p.id
  WHERE tee.entity_type = 'place' AND p.parent_place_id IS NOT NULL AND te.event_date IS NOT NULL
`).all();

const cityYearCounts = {}; // city_id -> { year -> count }
for (const e of cityEvents) {
  if (!e.yr) continue;
  if (!cityYearCounts[e.city_id]) cityYearCounts[e.city_id] = {};
  cityYearCounts[e.city_id][e.yr] = (cityYearCounts[e.city_id][e.yr] || 0) + 1;
}

const updateYears = db.prepare(`UPDATE places SET years_lived = ? WHERE id = ?`);
const cities = db.prepare(`SELECT id, name FROM places WHERE place_type = 'city'`).all();
for (const city of cities) {
  const yc = cityYearCounts[city.id] || {};
  const yearsLived = Object.values(yc).filter(c => c >= 50).length;
  if (dryRun) {
    const tv = db.prepare(`SELECT total_visits FROM places WHERE id = ?`).get(city.id)?.total_visits || 0;
    if (yearsLived > 0 || tv > 10) console.info(`  ${city.name}: years_lived=${yearsLived}, total_visits=${tv}`);
  } else {
    updateYears.run(yearsLived, city.id);
  }
}
console.info(`City intelligence: ${cities.length} cities computed`);

// --- 3. Sub-category classification (restaurants + bars only) ---
const toClassify = db.prepare(
  `SELECT id, name FROM places WHERE place_subtype IN ('restaurant','bar') AND sub_type IS NULL${limit ? ` LIMIT ${limit}` : ''}`
).all();

console.info(`Sub-type classification: ${toClassify.length} places${dryRun ? ' (dry run)' : ''}`);

if (toClassify.length) {
  const CUISINE_TYPES = 'Italian, Japanese, American, Mexican, French, Indian, Mediterranean, Asian, Seafood, Steakhouse, Brunch, Pizza, Cafe, Cocktail, Wine, Sports, Dive, Lounge, Pub, Other';
  const SYSTEM = `Classify each place's sub-category. Return a JSON array of types in input order. Types: ${CUISINE_TYPES}. Use the name to infer cuisine/style.`;
  const BATCH_SIZE = 30;
  const updateSub = db.prepare('UPDATE places SET sub_type = ? WHERE id = ?');

  const batches = [];
  for (let i = 0; i < toClassify.length; i += BATCH_SIZE) batches.push(toClassify.slice(i, i + BATCH_SIZE));

  let classified = 0;
  for (let i = 0; i < batches.length; i += 5) {
    await Promise.all(batches.slice(i, i + 5).map(async (batch) => {
      const numbered = batch.map((r, j) => `${j + 1}. ${r.name}`).join('\n');
      const resp = await (await getProvider('anthropic')).complete({
        model: modelFor('fast'), max_tokens: 512, system: SYSTEM,
        messages: [{ role: 'user', content: numbered }],
      });
      const raw = resp.content[0].text;
      const match = raw.match(/\[[\s\S]*?\]/);
      if (!match) { console.warn(`  Failed to parse batch, skipping`); return; }
      const types = JSON.parse(match[0]);
      for (let j = 0; j < batch.length; j++) {
        const sub = types[j] || 'Other';
        if (dryRun) console.info(`  ${batch[j].name} => ${sub}`);
        else updateSub.run(sub, batch[j].id);
        classified++;
      }
    }));
    console.info(`  ${Math.min((i + 5) * BATCH_SIZE, toClassify.length)}/${toClassify.length}`);
  }
  console.info(`Classified ${classified} sub-types`);
}

// --- Summary ---
const usefulCount = db.prepare(`SELECT COUNT(*) as n FROM places WHERE useful = 1 AND place_type = 'venue'`).get().n;
const totalPlaces = db.prepare(`SELECT COUNT(*) as n FROM places WHERE place_type = 'venue'`).get().n;
console.info(`\nResult: ${usefulCount}/${totalPlaces} useful places`);
