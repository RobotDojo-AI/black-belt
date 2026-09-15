#!/usr/bin/env node
import db from '../lib/db.js';
import { seedWorldLogs } from '../lib/workbench-log-seed.js';

const args = process.argv.slice(2);
const reason = args.includes('--reason');
const maxCreates = Number(process.env.ROBOTDOJO_LOG_SEED_MAX || args.find((a) => /^\d+$/.test(a)) || 80);

const seed = seedWorldLogs(db, { maxCreates });
console.log(JSON.stringify({ seed }));

if (reason) {
  const { reasonWorldLogs } = await import('../lib/workbench-log-reason.js');
  const { spentIn } = await import('../lib/spend-guard.js');
  const maxReasons = Number(process.env.ROBOTDOJO_LOG_REASON_MAX || 500);
  const maxUsd = Number(process.env.ROBOTDOJO_LOG_REASON_USD || 5);
  const start = spentIn('day').pipeline;
  const result = await reasonWorldLogs(db, {
    maxReasons,
    shouldStop: () => spentIn('day').pipeline - start >= maxUsd,
  });
  console.log(JSON.stringify({ reason: result, spentUsd: Number((spentIn('day').pipeline - start).toFixed(4)) }));
}
