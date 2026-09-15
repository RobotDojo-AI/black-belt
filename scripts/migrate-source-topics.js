#!/usr/bin/env node
/**
 * Move existing email chunks onto domain-routed topics and link company
 * timeline/log. Safe to re-run. Bounded --limit per fire.
 */
import { bulkMigrateEmailTopics, migrateSourceTopics } from '../lib/source-topic-migrate.js';
import db from '../lib/db.js';

const limitFlag = process.argv.indexOf('--limit');
const limit = limitFlag >= 0 ? Number(process.argv[limitFlag + 1]) : 800;
const skipVec = process.argv.includes('--skip-vec');
const bulk = process.argv.includes('--bulk') || !process.argv.includes('--limit');
const result = bulk
  ? bulkMigrateEmailTopics(db)
  : migrateSourceTopics(db, {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 800,
    skipVec,
  });
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
