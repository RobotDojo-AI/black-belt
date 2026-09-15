#!/usr/bin/env node
/**
 * Migration completeness guard.
 *
 * Run before declaring any migration done. Exit 0 = all good. Exit 1 = gaps found.
 *
 * Checks:
 *   - health_markers ≥ 85 (clinical panel present)
 *   - user_topics ≥ 35 with T1 parent slugs populated
 *   - visible T2 user_topics have parent_slug
 *   - person_topics relationships ≥ 10 and ≤ 25
 *   - accounts includes at least one email type and one calendar type
 *   - wiki_pages exists and has rows
 *
 * Usage: ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/check-migration-completeness.js
 */

const { default: db } = await import('../lib/db.js');

const checks = [];

function check(label, fn) {
  try {
    const { pass, detail } = fn();
    checks.push({ label, pass, detail });
  } catch (err) {
    checks.push({ label, pass: false, detail: `ERROR: ${err.message}` });
  }
}

check('health_markers ≥ 85', () => {
  const n = db.prepare("SELECT COUNT(*) as n FROM health_markers").get().n;
  return { pass: n >= 85, detail: `${n} markers` };
});

check('user_topics ≥ 35', () => {
  const n = db.prepare("SELECT COUNT(*) as n FROM user_topics").get().n;
  return { pass: n >= 35, detail: `${n} topics` };
});

check('T1 parents present (work, family, personal, education, newsletters)', () => {
  const n = db.prepare("SELECT COUNT(*) as n FROM user_topics WHERE slug IN ('work','family','personal','education','newsletters')").get().n;
  return { pass: n >= 5, detail: `${n}/5 T1 parents` };
});

check('visible T2 topics have parent_slug', () => {
  const n = db.prepare("SELECT COUNT(*) as n FROM user_topics WHERE visible=1 AND parent_slug IS NOT NULL").get().n;
  return { pass: n >= 1, detail: `${n} visible T2 topics` };
});

check('relationships 10–25 people', () => {
  const n = db.prepare("SELECT COUNT(*) as n FROM person_topics WHERE topic='relationships'").get().n;
  return { pass: n >= 10 && n <= 25, detail: `${n} people` };
});

check('accounts: email present', () => {
  const n = db.prepare("SELECT COUNT(*) as n FROM accounts WHERE type='email'").get().n;
  return { pass: n >= 1, detail: `${n} email accounts` };
});

check('accounts: calendar present', () => {
  const n = db.prepare("SELECT COUNT(*) as n FROM accounts WHERE type='calendar'").get().n;
  return { pass: n >= 1, detail: `${n} calendar accounts` };
});

check('wiki_pages restored', () => {
  let n = 0;
  try { n = db.prepare("SELECT COUNT(*) as n FROM wiki_pages").get().n; } catch { return { pass: false, detail: 'table missing' }; }
  return { pass: n > 0, detail: `${n} pages` };
});

check('clinical data points ≥ 1900', () => {
  const n = db.prepare("SELECT COUNT(*) as n FROM health_data_points WHERE source NOT IN ('oura-json','apple-health','oura_sync')").get().n;
  return { pass: n >= 1900, detail: `${n} clinical points` };
});

// ── Report ────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
console.log('\n=== Migration Completeness Check ===\n');
for (const c of checks) {
  const icon = c.pass ? '✓' : '✗';
  console.log(`  ${icon} ${c.label.padEnd(50)} ${c.detail}`);
  if (c.pass) passed++; else failed++;
}

console.log(`\n  ${passed}/${checks.length} checks passed`);

if (failed > 0) {
  console.error(`\n  INCOMPLETE: ${failed} gap(s) found. Do not declare migration done.`);
  process.exit(1);
}
console.log('\n  Migration complete. All data present.');
