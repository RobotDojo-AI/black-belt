#!/usr/bin/env node
import { buildHealthRecoveryStatus } from '../lib/health-recovery-status.js';

const args = parseArgs(process.argv.slice(2));
const { default: db } = await import('../lib/db.js');
const status = buildHealthRecoveryStatus(db);

if (args.json) {
  console.log(JSON.stringify(status, null, 2));
} else {
  console.log(`Health recovery: ${status.ok ? 'ready' : 'not ready'} (${status.recovery_mode})`);
  console.log(`DB: ${status.db.active_points} active points, ${status.db.pdf_lab_points} PDF lab points, ${status.db.markers} markers`);
  console.log(`PDF vault: ${status.source_files.pdf_vault_files} files`);
  console.log(`PDF manifest: ${status.manifest.ok ? 'verified' : 'failed'}`);
  console.log(`Backup: ${status.backup.provider} ${status.backup.configured ? 'configured' : 'not configured'}`);
  if (!status.ok) console.log(`Missing: ${status.missing.join(', ')}`);
}

if (!status.ok && args.strict) process.exit(1);

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    if (arg === '--strict') out.strict = true;
  }
  return out;
}
