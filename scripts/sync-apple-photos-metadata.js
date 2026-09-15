#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { syncApplePhotosMetadata } from '../lib/apple-photos-sync.js';

export { syncApplePhotosMetadata } from '../lib/apple-photos-sync.js';

export function runSyncApplePhotosMetadataCli(argv = process.argv, stdout = process.stdout) {
  const limitIndex = argv.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : 1000;
  const result = syncApplePhotosMetadata({ limit: Number.isFinite(limit) ? limit : 1000 });
  stdout.write(`[sync-apple-photos-metadata] imported ${result.imported} photo metadata row(s)\n`);
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runSyncApplePhotosMetadataCli();
  } catch (err) {
    process.stderr.write(`[sync-apple-photos-metadata] ${err.message}\n`);
    process.exit(1);
  }
}
