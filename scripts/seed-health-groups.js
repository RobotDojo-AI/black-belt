#!/usr/bin/env node
/**
 * Seed health_groups with default categories for the Pulse app.
 *
 * Idempotent: INSERT OR IGNORE on stable slug ids. Safe to run repeatedly
 * and won't clobber user-renamed rows.
 *
 * This script mirrors the `seed-health-groups` migration in lib/db.js, which
 * is the automatic path on first boot. Use this script only for manual
 * re-seeds against a foreign DB (e.g. a staging snapshot):
 *
 *   node scripts/seed-health-groups.js
 *   ROBOTDOJO_DB=/path/to/db node scripts/seed-health-groups.js
 *
 * No PII: generic category names only. Users curate their own groups via the
 * Pulse app or chat tools.
 */
import db from '../lib/db.js';

// Generic, MECE-ish categories. Users can rename/add/remove via chat.
const DEFAULT_GROUPS = [
  { id: 'vitals',            name: 'Vitals',              description: 'Blood pressure, heart rate, temperature' },
  { id: 'body_composition',  name: 'Body Composition',    description: 'Weight, BMI, body fat, waist' },
  { id: 'metabolic',         name: 'Metabolic',           description: 'Glucose, A1C, insulin, lipids' },
  { id: 'cardiovascular',    name: 'Cardiovascular',      description: 'Cholesterol, triglycerides, blood pressure' },
  { id: 'blood',             name: 'Blood Counts',        description: 'CBC: hemoglobin, WBC, platelets' },
  { id: 'kidney',            name: 'Kidney',              description: 'Creatinine, eGFR, BUN' },
  { id: 'liver',             name: 'Liver',               description: 'ALT, AST, bilirubin, alk phos' },
  { id: 'hormones',          name: 'Hormones',            description: 'Thyroid, testosterone, cortisol' },
  { id: 'inflammation',      name: 'Inflammation',        description: 'CRP, ESR, immune markers' },
  { id: 'vitamins_minerals', name: 'Vitamins & Minerals', description: 'Vitamin D, B12, iron, magnesium' },
  { id: 'sleep',             name: 'Sleep & Recovery',    description: 'Sleep stages, HRV, resting heart rate' },
  { id: 'user_tracked',      name: 'User Tracked',        description: 'Manually tracked metrics' },
];

export function seedHealthGroups() {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO health_groups (id, name, description) VALUES (?, ?, ?)'
  );
  const tx = db.transaction((groups) => {
    for (const g of groups) insert.run(g.id, g.name, g.description);
  });
  tx(DEFAULT_GROUPS);

  const total = db.prepare('SELECT COUNT(*) AS n FROM health_groups').get().n;
  return { attempted: DEFAULT_GROUPS.length, total };
}

// Run as a script when invoked directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = seedHealthGroups();
  console.info(`[seed-health-groups] attempted=${result.attempted} total=${result.total}`);
}
