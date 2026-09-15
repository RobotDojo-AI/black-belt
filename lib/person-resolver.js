/**
 * person-resolver.js — import compatibility stub.
 *
 * FREEMAIL_DOMAINS lives in entity-resolve.js. This stub re-exports it so
 * callers (scripts/ingest/05-score.js etc.) continue to work without
 * knowing where the implementation lives.
 *
 * WHY a stub: FREEMAIL_DOMAINS is a static set that belongs in entity-resolve.js
 * (the canonical WB resolution module). The stub preserves import compatibility
 * for consuming scripts without duplicating the list.
 */
export { FREEMAIL_DOMAINS } from './entity-resolve.js';
