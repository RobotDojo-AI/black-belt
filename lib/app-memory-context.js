// lib/app-memory-context.js - shared memory continuity layer for product apps.
//
// Apps specialize the domain view, but they should not fork memory semantics.
// This helper routes app intelligence through the same tiered, replayable memory
// packet used by chat and build.

import db from './db.js';
import { buildMemoryContextPacket, MEMORY_CONTEXT_TIERS } from './memory-context.js';
import { PIPELINE_STORIES_DIR, REPO_ROOT } from './robotdojo-paths.js';

const APP_TOPIC_DEFAULTS = Object.freeze({
  health: 'health',
  coaching: 'coaching',
  network: 'networking',
});

export function appMemoryTopic(app, explicitTopic = null) {
  if (explicitTopic) return explicitTopic;
  return APP_TOPIC_DEFAULTS[String(app || '').toLowerCase()] || String(app || '').toLowerCase() || null;
}

export function appMemoryQuery(app, extra = '') {
  return [
    String(app || 'app'),
    'latest thinking decisions next steps chronology evolution snapshots official views conflicts memory',
    extra,
  ].filter(Boolean).join(' ');
}

export async function buildAppMemoryContext({
  database = db,
  app,
  topic = null,
  query = '',
  tier = 'workbench',
  maxChars = null,
  asOf = '',
  entities = [],
  literal = null,
  includeSynthesis = false,
  repoRoot = REPO_ROOT,
  storiesDir = PIPELINE_STORIES_DIR,
} = {}) {
  const resolvedTopic = appMemoryTopic(app, topic);
  const packet = await buildMemoryContextPacket({
    db: database,
    query: query || appMemoryQuery(app),
    topic: resolvedTopic,
    entities,
    tier,
    maxChars: maxChars || MEMORY_CONTEXT_TIERS[tier]?.maxChars || MEMORY_CONTEXT_TIERS.workbench.maxChars,
    asOf,
    repoRoot,
    storiesDir,
    literal,
    includeSynthesis,
  });
  if (!packet) return '';
  return `## App Memory Continuity (${String(app || resolvedTopic || 'app')})\n\n${packet}`;
}
