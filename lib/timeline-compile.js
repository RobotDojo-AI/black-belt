/**
 * LLM synthesis — turns raw timeline events into compiled intelligence views.
 * Users see compiled views, never raw timelines.
 */

// INTELLIGENCE_TIER: synthesis — callSonnet calls an LLM to compile a person's
// timeline into a persisted view; the deterministic upsertView statement
// (not the LLM) performs the compiled_views write, mirroring the same
// LLM-writes-content/deterministic-code-writes-storage split as entity cards.
export const INTELLIGENCE_TIER = 'synthesis';

import db from './db.js';
import config from './config.js';
import { getPersonTimeline } from './timeline-schema.js';
import { llmCreate } from './llm-gateway.js';
import { ownerDisplayName } from './identity.js';
import { PRICING } from './compute-tier.js';

// --- Prepared statements ---

const stmts = {
  getView: db.prepare(`
    SELECT * FROM compiled_views
    WHERE entity_type = @entityType AND entity_id = @entityId AND view_type = @viewType
  `),

  upsertView: db.prepare(`
    INSERT INTO compiled_views (entity_type, entity_id, view_type, content, evidence_ids, compiled_at, stale)
    VALUES (@entityType, @entityId, @viewType, @content, @evidenceIds, datetime('now'), 0)
    ON CONFLICT(entity_type, entity_id, view_type)
    DO UPDATE SET content = @content, evidence_ids = @evidenceIds, compiled_at = datetime('now'), stale = 0
  `),

  markStale: db.prepare(`
    UPDATE compiled_views SET stale = 1
    WHERE entity_type = @entityType AND entity_id = @entityId
  `),

  markStaleByView: db.prepare(`
    UPDATE compiled_views SET stale = 1
    WHERE entity_type = @entityType AND entity_id = @entityId AND view_type = @viewType
  `),

  allStale: db.prepare(`
    SELECT DISTINCT entity_type, entity_id FROM compiled_views WHERE stale = 1
  `),

  getPersonName: db.prepare(`SELECT display_name, tier FROM people WHERE id = ?`),
};

// --- Cost tracking ---

let sessionSpend = 0;

function trackCost(usage) {
  const inputCost = usage.input_tokens * PRICING.sonnet.input;
  const outputCost = usage.output_tokens * PRICING.sonnet.output;
  const cost = inputCost + outputCost;
  sessionSpend += cost;
  return cost;
}

function checkCap() {
  if (sessionSpend >= config.costs.maxCompileSpend) {
    console.warn(`[compile] Sonnet spend cap reached ($${sessionSpend.toFixed(2)} >= $${config.costs.maxCompileSpend})`);
    return false;
  }
  return true;
}

// --- LLM call ---

async function callSonnet(system, userContent) {
  const resp = await llmCreate({
    model: config.models.compile,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: userContent }],
  }, 'timeline-compile');
  const cost = trackCost(resp.usage);
  console.info(`[compile] sonnet call — ${resp.usage.input_tokens}in/${resp.usage.output_tokens}out, $${cost.toFixed(4)}`);
  return { content: resp.content[0].text, usage: resp.usage };
}

// --- Core compilation ---

/**
 * Compile a summary view for a person from their timeline events.
 * Returns the compiled view content or null if cap exceeded.
 */
export async function compilePersonView(personId) {
  if (!checkCap()) return null;

  const person = stmts.getPersonName.get(personId);
  if (!person) {
    console.warn(`[compile] person ${personId} not found, skipping`);
    return null;
  }

  // Gather recent events, grouped by source
  const events = getPersonTimeline(personId, { limit: 200 });
  if (events.length === 0) {
    console.info(`[compile] no timeline events for ${person.display_name}, skipping`);
    return null;
  }

  const grouped = {};
  for (const e of events) {
    if (!grouped[e.source_type]) grouped[e.source_type] = [];
    grouped[e.source_type].push(e);
  }

  // Build evidence summary for LLM
  const evidenceParts = [];
  for (const [source, items] of Object.entries(grouped)) {
    const lines = items.slice(0, 30).map((e) =>
      `  - [${e.event_date}] ${e.event_type}: ${e.summary}`
    );
    evidenceParts.push(`${source} (${items.length} events):\n${lines.join('\n')}`);
  }

  // Owner name comes from the user's own identity.json, not a hardcoded
  // literal — this prompt runs on every customer's machine.
  const ownerName = ownerDisplayName();
  const system = `You are an intelligence analyst synthesizing relationship data. Write a concise paragraph (3-6 sentences) about this person's relationship with the user (${ownerName}). Cover: how they know each other, communication patterns, key events, and current context. Be factual and specific. Do not speculate beyond the evidence.`;

  const userContent = `Person: ${person.display_name} (tier: ${person.tier})\nTotal events: ${events.length}\n\n${evidenceParts.join('\n\n')}`;

  const { content } = await callSonnet(system, userContent);
  const evidenceIds = events.slice(0, 50).map((e) => e.id);

  stmts.upsertView.run({
    entityType: 'person',
    entityId: personId,
    viewType: 'summary',
    content,
    evidenceIds: JSON.stringify(evidenceIds),
  });

  console.info(`[compile] compiled summary for ${person.display_name} (${events.length} events)`);
  return content;
}

/**
 * Recompile all views marked stale.
 * Only handles person summaries for now — extend for company/topic later.
 */
export async function compileAllStale() {
  sessionSpend = 0; // reset per-run so prior calls don't eat into this run's cap
  const staleEntities = stmts.allStale.all();
  if (staleEntities.length === 0) {
    console.info('[compile] no stale views');
    return { compiled: 0, skipped: 0 };
  }

  console.info(`[compile] ${staleEntities.length} stale entities to recompile`);
  let compiled = 0;
  let skipped = 0;

  for (const { entity_type, entity_id } of staleEntities) {
    if (!checkCap()) {
      skipped += staleEntities.length - compiled - skipped;
      break;
    }
    if (entity_type === 'person') {
      const result = await compilePersonView(entity_id);
      if (result) compiled++;
      else skipped++;
    } else {
      // Future: company, topic compilation
      skipped++;
    }
  }

  console.info(`[compile] stale recompile done — ${compiled} compiled, ${skipped} skipped, $${sessionSpend.toFixed(4)} spent`);
  return { compiled, skipped };
}

/**
 * Mark all compiled views for an entity as stale.
 */
export function markStale(entityType, entityId) {
  stmts.markStale.run({ entityType, entityId });
}

/**
 * Retrieve a compiled view.
 */
export function getCompiledView(entityType, entityId, viewType = 'summary') {
  return stmts.getView.get({ entityType, entityId, viewType }) || null;
}
