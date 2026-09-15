#!/usr/bin/env node
import { syncAsanaContext } from '../lib/asana-context-sync.js';
import { secret } from '../lib/config.js';
import { withScheduledDbWriterGuard } from '../lib/db-writer-policy.js';

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

const providerArg = argValue('--provider') || (process.argv.includes('--all') ? 'all' : 'asana');
const limit = Math.min(Math.max(Number(argValue('--limit') || 100) || 100, 1), 100);
const requestedProviders = providerArg === 'all'
  ? ['asana', 'asana_secondary']
  : [providerArg === 'asana_secondary' ? 'asana_secondary' : 'asana'];

try {
  const result = await withScheduledDbWriterGuard('sync-asana-context', async () => {
    const rows = [];
    for (const provider of requestedProviders) {
      const token = provider === 'asana_secondary' ? secret('ASANA_PAT_SECONDARY') : secret('ASANA_PAT');
      if (!token) {
        rows.push({ provider, skipped: true, reason: 'missing_token' });
        continue;
      }
      const sync = await syncAsanaContext({ token, provider, limit });
      rows.push({ provider, imported: sync.imported });
    }
    return rows;
  });
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
} catch (err) {
  process.stderr.write(`[sync-asana-context] ${err.message}\n`);
  process.exit(1);
}
