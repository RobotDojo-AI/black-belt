/**
 * Data queries for routes/integrations.js
 * Extracted by st_d499b891 (route-db-prepare-extraction).
 *
 * st_fd14cdd4 AC2: dispatch derives from lib/integration-registry.js — each
 * descriptor declares its own doc-count functions keyed by health-name prefix
 * (`gmail:email`, `microsoft-mail:email`, `imessage`, …). Unknown names return
 * null (blank count), same as before; adding an integration means adding a
 * descriptor, not a branch here.
 */
import { docCountFor } from './integration-registry.js';

/**
 * Returns the doc count for a named integration_health row.
 * @param {import('better-sqlite3').Database} db
 * @param {string} integrationName — `{job}` or `{job}:{email}`
 * @returns {number | null}
 */
export function getDocCount(db, integrationName) {
  try {
    return docCountFor(db, integrationName);
  } catch { /* table may not exist yet */ }
  return null;
}
