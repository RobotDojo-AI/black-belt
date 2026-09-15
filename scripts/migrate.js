#!/usr/bin/env node
/**
 * Apply pending database migrations.
 *
 * Migrations live in lib/db.js and run on import (see migrate() calls).
 * Importing db.js here is sufficient to apply any pending migrations —
 * the module self-applies and records them in the `migrations` table.
 *
 * Usage: npm run migrate
 *        ROBOTDOJO_DB=/path/to/db node scripts/migrate.js
 */
// Tell db.js this is a migration run, so it will bootstrap a fresh DB
// instead of throwing when the DB doesn't exist yet.
process.env.ROBOTDOJO_MIGRATING = '1';
// Ensure the parent directory exists on a fresh install.
// db.js owns the actual path; we create the
// config directory before importing db.js on a fresh install.
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
mkdirSync(process.env.ROBOTDOJO_CONFIG || resolve(homedir(), '.robotdojo'), { recursive: true });

const { default: db } = await import('../lib/db.js');

const applied = db.prepare('SELECT name, applied_at FROM migrations ORDER BY applied_at').all();
console.info(`[migrate] ${applied.length} migration(s) recorded`);
for (const m of applied) {
  console.info(`  - ${m.name} (${m.applied_at})`);
}
console.info('[migrate] done');
