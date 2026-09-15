/**
 * tier-0/pending-migration.js — match against pending_migrations from registry.
 *
 * WHY: when STRUCTURE.md declares a directory migration is pending (e.g.
 * `research/` → `pipeline/archive/research/`), files landing in the legacy
 * location get auto-routed to the new location. Example #5 from the spec (research
 * markdown files) is exactly this case.
 */

import { pendingMigrationFor } from '../registry.js';

export function detectPendingMigration(absPath, relPath, registry) {
  if (!relPath) return null;
  const mig = pendingMigrationFor(relPath, registry);
  if (!mig) return null;

  // Compute the new path: replace the `from` prefix with `to`.
  const newPath = mig.to + relPath.slice(mig.from.length);

  return {
    signal_name: 'pending-migration',
    destination: newPath,
    confidence: 0.9,
    reason: `pending migration ${mig.from} → ${mig.to}`,
    action: 'move-to-canonical',
  };
}
