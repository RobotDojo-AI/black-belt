#!/usr/bin/env node
/** Place dedup — merge duplicate places within each city group.
 *  Usage: node scripts/dedup-places.js [--dry-run] [--limit N] */
import db from '../lib/db.js';

function jaroWinkler(s1, s2) {
  if (s1 === s2) return 1;
  const l1 = s1.length, l2 = s2.length;
  const window = Math.floor(Math.max(l1, l2) / 2) - 1;
  if (window < 0) return 0;
  const m1 = new Array(l1).fill(false), m2 = new Array(l2).fill(false);
  let matches = 0;
  for (let i = 0; i < l1; i++) {
    const lo = Math.max(0, i - window), hi = Math.min(i + window, l2 - 1);
    for (let j = lo; j <= hi; j++) {
      if (!m2[j] && s1[i] === s2[j]) { m1[i] = m2[j] = true; matches++; break; }
    }
  }
  if (matches === 0) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < l1; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  const jaro = (matches / l1 + matches / l2 + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, l1, l2); i++) { if (s1[i] === s2[i]) prefix++; else break; }
  return jaro + prefix * 0.1 * (1 - jaro);
}

const args = process.argv.slice(2), dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const coreName = (n) => n.split(/[,\n]/)[0].trim().replace(/^the\s+/i, '').toLowerCase().trim();
const isBare = (n) => !n.includes(',') && !/\d/.test(n);
const leadNum = (s) => s.match(/^\d+/)?.[0] ?? null;
const hasAddr = (v) => v.name.includes(',') || /\d/.test(v.name);
const pickKeeper = (g) => g.reduce((b, v) => {
  if (hasAddr(v) && !hasAddr(b)) return v;
  if (!hasAddr(v) && hasAddr(b)) return b;
  return v.name.length > b.name.length ? v : b;
});

const updateKeeper = db.prepare(`UPDATE places SET frequency=@freq, first_seen=@firstSeen, last_seen=@lastSeen WHERE id=@id`);
const reassign = db.prepare(`UPDATE timeline_event_entities SET entity_id=@keeperId WHERE entity_type='place' AND entity_id=@oldId`);
const del = db.prepare(`DELETE FROM places WHERE id=@id`);
db.pragma('foreign_keys = OFF');
const mergeTxn = db.transaction((keeper, dupes) => {
  let freq = keeper.frequency || 0, first = keeper.first_seen, last = keeper.last_seen;
  for (const d of dupes) {
    freq += d.frequency || 0;
    if (d.first_seen && (!first || d.first_seen < first)) first = d.first_seen;
    if (d.last_seen && (!last || d.last_seen > last)) last = d.last_seen;
    reassign.run({ keeperId: String(keeper.id), oldId: String(d.id) });
    del.run({ id: d.id });
  }
  updateKeeper.run({ id: keeper.id, freq, firstSeen: first, lastSeen: last });
});

let merges = 0, bareCount = 0;
const doMerge = (tag, keeper, dupes) => {
  if (dryRun) console.info(`  MERGE [${tag}] keep "${keeper.name}" <- ${dupes.map(d => `"${d.name}"`).join(', ')}`);
  else mergeTxn(keeper, dupes);
  merges += dupes.length;
};

console.info('=== Place Dedup ===');
if (dryRun) console.info('DRY RUN — no writes\n');

const places = db.prepare(`SELECT * FROM places WHERE place_type = 'venue'`).all();
const beforeCount = places.length;
const byCity = new Map();
for (const v of places) { const k = v.parent_place_id ?? 'none'; (byCity.get(k) ?? byCity.set(k, []).get(k)).push(v); }

for (const key of [...byCity.keys()].slice(0, limit)) {
  const group = byCity.get(key);
  if (group.length < 2) continue;
  // Pass 1: exact core-name
  const coreMap = new Map();
  for (const v of group) { const cn = coreName(v.name); (coreMap.get(cn) ?? coreMap.set(cn, []).get(cn)).push(v); }
  const matched = new Set();
  for (const [, m] of coreMap) {
    if (m.length < 2) continue;
    const k = pickKeeper(m);
    doMerge('exact', k, m.filter(x => x.id !== k.id));
    for (const x of m) matched.add(x.id);
  }
  // Pass 2: Jaro-Winkler (min 10 chars, same leading digits, >=0.93)
  const rem = group.filter(v => !matched.has(v.id)), used = new Set();
  for (let i = 0; i < rem.length; i++) {
    if (used.has(rem[i].id)) continue;
    const cn1 = coreName(rem[i].name);
    if (cn1.length < 10) continue;
    const d1 = leadNum(cn1), cluster = [rem[i]];
    for (let j = i + 1; j < rem.length; j++) {
      if (used.has(rem[j].id)) continue;
      const cn2 = coreName(rem[j].name);
      if (cn2.length < 10 || (d1 && leadNum(cn2) && d1 !== leadNum(cn2))) continue;
      if (jaroWinkler(cn1, cn2) >= 0.93) { cluster.push(rem[j]); used.add(rem[j].id); }
    }
    if (cluster.length > 1) {
      used.add(rem[i].id);
      const k = pickKeeper(cluster);
      doMerge('fuzzy', k, cluster.filter(x => x.id !== k.id));
    }
  }
}

// Pass 3: bare-name places — match to proper-address place in same city
const findAddr = db.prepare(`SELECT * FROM places WHERE place_type='venue' AND id!=@id AND parent_place_id IS @parent AND name LIKE '%,%' LIMIT 1`);
for (const v of db.prepare(`SELECT * FROM places WHERE place_type = 'venue'`).all()) {
  if (!isBare(v.name)) continue;
  bareCount++;
  const c = findAddr.get({ id: v.id, parent: v.parent_place_id });
  if (c && jaroWinkler(coreName(v.name), coreName(c.name)) >= 0.85) doMerge('bare', c, [v]);
}

const afterCount = db.prepare(`SELECT COUNT(*) as n FROM places WHERE place_type='venue'`).get().n;
console.info(`\n=== Stats ===`);
console.info(`Before: ${beforeCount} | After: ${afterCount} | Merges: ${merges} | Bare-name: ${bareCount}`);
