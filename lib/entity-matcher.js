/**
 * entity-matcher.js — import compatibility stub.
 *
 * normalizePhone lives in entity-resolve.js. This stub re-exports it so
 * callers (scripts/ingest/03-timeline.js etc.) continue to work without
 * knowing where the implementation lives.
 *
 * WHY a stub instead of moving: entity-resolve.js is the canonical White Belt
 * resolution module. Merging everything into one file would break the clear
 * WB/BB boundary. The stub is the thinnest compatible surface.
 */
export { normalizePhone } from './entity-resolve.js';
