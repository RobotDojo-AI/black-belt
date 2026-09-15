/**
 * lib/topic-distill.js — the single topic-context distiller
 * (design-unified-architecture.md §2, st_5184eb86 chunks 4-5).
 *
 * INTELLIGENCE_TIER = 'synthesis' (reads structure, calls Sonnet, writes
 * canonical markdown only — never a DB fact/claim/edge row; the LLM write
 * boundary in build-conventions.md holds).
 *
 * THE PROBLEM COLLAPSED: two engines race on user_topics.context_md today —
 * generateTopicContext() (lib/topic-context.js — Sonnet narrative, direct
 * UPDATE, no watermark) and synthesizeWorkbench() (lib/workbench-synthesis.js
 * — deterministic replay, watermarked, writes through the guarded
 * applyTopicContext() path). distillTopic() below runs both halves in one
 * pass, in three stages:
 *
 *   Stage A — grounding (deterministic). Reuse collectWorkbenchSynthesisSources()
 *     (the event-sourced replay, read-only) when the topic has a registered
 *     workbench, PLUS provenance-tagged entity_facts/entity_claims for the
 *     topic's linked entities (collectEntityProvenanceGrounding below).
 *   Stage B — grounded synthesis (Sonnet). The EXACT prompt
 *     generateTopicContext() already used (reused via
 *     gatherTopicSynthesisContext()/synthesizeSummaryFromContext() —
 *     lib/topic-context.js's chunk-4 split), fed the extra provenance
 *     grounding block and a hardened hedge contract: assert user-stated/
 *     primary-source facts plainly, hedge llm-distilled-only claims, state
 *     nothing the grounding set doesn't support.
 *   Stage C — one write path. applyTopicContext() (source='topic-distill',
 *     precedence tier 3 — lib/topic-context-apply.js), gated by a
 *     post-generation date/number validator (reuses lib/entity-card.js's
 *     validateCardDatesAndNumbers, chunk 3) that redacts any specific date or
 *     number the grounding set's ASSERT-tier facts don't support.
 *
 * DESIGN DEVIATION (documented): §1.4 describes a physical `v_entity_provenance`
 * SQL VIEW unioning entity_facts + entity_claims. This file does the identical
 * union in JS (collectEntityProvenanceGrounding) instead of creating that view,
 * because CREATE VIEW is DDL — it would require calling the lazy schema-ensure
 * helpers (ensureEntityFactsProvenanceColumns / ensureEntityClaimsSchema) on
 * every distill run, and DDL cannot run against a read-only connection or a
 * live DB that hasn't had the owner-run provenance backfill applied yet. The
 * JS union needs no DDL at all — it degrades gracefully via
 * hasEntityFactsProvenanceColumns()/hasTable() checks, exactly the existing
 * lazy-ensure convention (entity-facts.js, entity-claims.js). Net effect is
 * identical grounding data; the physical view remains a future addition for a
 * consumer that specifically wants raw SQL access.
 *
 * CUTOVER FLAG (mergeable-without-surprise — the safety spine of chunk 5):
 * isTopicDistillEnabled() defaults OFF (config/defaults.json topic_distill.enabled
 * = false; env override ROBOTDOJO_TOPIC_DISTILL_ENABLED=1/0). With the flag off,
 * distillOrGenerateTopicContext() below delegates straight to the untouched
 * generateTopicContext() — routes/api.js and the TOPICS maintenance phase run
 * EXACTLY as they do today. Nothing in this file is reachable from any live
 * code path until the owner flips the flag. See the OWNER CUTOVER note above
 * isTopicDistillEnabled() for the exact flip.
 */
export const INTELLIGENCE_TIER = 'synthesis';

import crypto from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  gatherTopicSynthesisContext,
  synthesizeSummaryFromContext,
  generateTopicContext,
} from './topic-context.js';
import { applyTopicContext } from './topic-context-apply.js';
import {
  collectWorkbenchSynthesisSources,
  synthesizeDeterministically,
  formatSynthesisMarkdown,
} from './workbench-synthesis.js';
import { getWorkbench, resolveWorkbench } from './workbenches.js';
import { toRepoPath } from './workbench-files.js';
import { REPO_ROOT } from './robotdojo-paths.js';
import { hasEntityFactsProvenanceColumns } from './entity-facts.js';
import { SOURCE_CLASS, resolveSourceClass, hedgePolicy, hedgePhrase } from './provenance.js';
import { validateCardDatesAndNumbers } from './entity-card.js';
import { recordProjectionRun, stableJson } from './memory-events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Same 4k Summary budget generateTopicContext()/workbench-synthesis.js use —
// the distiller writes the identical context_md shape, so the chat injector
// (lib/chat-context.js) needs no changes to consume either engine's output.
let TOPIC_SUMMARY_CHAR_BUDGET = 4000;
try {
  const _d = JSON.parse(readFileSync(join(__dirname, '../config/defaults.json'), 'utf8'));
  TOPIC_SUMMARY_CHAR_BUDGET = _d.chat_injection?.per_topic_chars ?? 4000;
} catch { /* fall back to the literal default above */ }

const TOPIC_IDENTITY_CHAR_BUDGET = 1000;

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function hasTable(db, table) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  } catch {
    return false;
  }
}

// ── Cutover flag ─────────────────────────────────────────────────────────────

function loadTopicDistillConfig() {
  try {
    const raw = readFileSync(join(__dirname, '../config/defaults.json'), 'utf8');
    return JSON.parse(raw).topic_distill || {};
  } catch {
    return {};
  }
}

/**
 * Read fresh every call (never cached) — this is a maintenance/route-level
 * check (called at most a handful of times per topic regen), not a chat hot
 * path, so a JSON.parse per call costs nothing measurable and a live config
 * edit (or env override) takes effect immediately with no process restart.
 *
 * OWNER CUTOVER STEP: flip `topic_distill.enabled` to `true` in
 * config/defaults.json (or set ROBOTDOJO_TOPIC_DISTILL_ENABLED=1 in the
 * server environment) to activate the unified distiller in place of the two
 * racing engines. Merging this branch with the flag untouched (false) changes
 * nothing live — this is the ONLY step required for cutover; no code edit,
 * no manual migration run, no phase toggle.
 */
export function isTopicDistillEnabled() {
  const env = process.env.ROBOTDOJO_TOPIC_DISTILL_ENABLED;
  if (env === '1') return true;
  if (env === '0') return false;
  return Boolean(loadTopicDistillConfig().enabled);
}

// ── Stage A(iii) — entity_facts/entity_claims provenance grounding ─────────

function entityDisplayName(db, entityId) {
  try {
    const person = db.prepare('SELECT display_name FROM people WHERE id = ?').get(entityId);
    if (person?.display_name) return person.display_name;
  } catch { /* people table absent in a minimal fixture — non-fatal */ }
  try {
    const company = db.prepare('SELECT name FROM companies WHERE id = ?').get(entityId);
    if (company?.name) return company.name;
  } catch { /* companies table absent — non-fatal */ }
  return entityId;
}

/**
 * Provenance-tagged fact/claim grounding for a set of topic-linked entities
 * (design §1.4/§2.2 Stage A — see the DESIGN DEVIATION note above for why this
 * is a JS union rather than the literal v_entity_provenance SQL view). Every
 * row resolves through resolveSourceClass()/hedgePolicy() (lib/provenance.js,
 * chunk 1) BEFORE it reaches the caller, so Stage B and Stage C both work off
 * the same assert/hedge/omit decision — no drift between what the prompt says
 * and what the validator checks.
 *
 * Read-only. Gracefully degrades to empty when entity_facts lacks the
 * provenance columns (pre-backfill live DB) or entity_claims doesn't exist yet
 * (pre-chunk-2 DB) — never throws, matches the "graceful degradation" build
 * convention.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string[]} entityIds
 * @returns {Array<{entityId,entityName,kind:'fact'|'claim',label:string,value:string,
 *   sourceClass:string,confidence:number,policy:'assert'|'hedge'|'omit',validAt:?string}>}
 */
export function collectEntityProvenanceGrounding(db, entityIds) {
  const items = [];
  if (!entityIds?.length) return items;

  const factsProvenanced = hasEntityFactsProvenanceColumns(db);
  const factCols = factsProvenanced
    ? 'fact_type, fact_value, source_class, confidence, model_tier, valid_at'
    : 'fact_type, fact_value, model_tier, valid_at';
  let factStmt = null;
  try {
    factStmt = db.prepare(`
      SELECT ${factCols} FROM entity_facts
      WHERE entity_id = ? AND invalid_at IS NULL
      ORDER BY extracted_at DESC
      LIMIT 20
    `);
  } catch { factStmt = null; }

  const claimsExist = hasTable(db, 'entity_claims');
  let claimStmt = null;
  if (claimsExist) {
    try {
      claimStmt = db.prepare(`
        SELECT claim_type, claim_value, source_class, confidence, valid_at
        FROM entity_claims
        WHERE entity_id = ? AND invalid_at IS NULL
        ORDER BY recorded_at DESC
        LIMIT 20
      `);
    } catch { claimStmt = null; }
  }

  for (const entityId of entityIds) {
    const entityName = entityDisplayName(db, entityId);

    if (factStmt) {
      let facts = [];
      try { facts = factStmt.all(entityId); } catch { facts = []; }
      for (const row of facts) {
        const sourceClass = resolveSourceClass('entity_facts', row);
        // A legacy (pre-provenance) row has no stored confidence — fall back
        // to the same default sourceClassForModelTier() would assign so the
        // hedge decision below is never computed against `undefined`.
        const confidence = row.confidence ?? (sourceClass === SOURCE_CLASS.PRIMARY_SOURCE ? 1.0 : 0.6);
        items.push({
          entityId, entityName, kind: 'fact',
          label: row.fact_type, value: row.fact_value,
          sourceClass, confidence,
          policy: hedgePolicy(sourceClass, confidence),
          validAt: row.valid_at || null,
        });
      }
    }

    if (claimStmt) {
      let claims = [];
      try { claims = claimStmt.all(entityId); } catch { claims = []; }
      for (const row of claims) {
        const sourceClass = resolveSourceClass('entity_claims', row);
        items.push({
          entityId, entityName, kind: 'claim',
          label: row.claim_type, value: row.claim_value,
          sourceClass, confidence: row.confidence,
          policy: hedgePolicy(sourceClass, row.confidence),
          validAt: row.valid_at || null,
        });
      }
    }
  }
  return items;
}

/**
 * Render provenance grounding items into prompt lines. An 'assert' item
 * renders plainly (user-stated/primary-source — state it as fact); a 'hedge'
 * item is wrapped via hedgePhrase() BEFORE it reaches Sonnet at all — the
 * belt, with the Stage C validator as the suspenders; an 'omit' item never
 * renders.
 *
 * @param {ReturnType<typeof collectEntityProvenanceGrounding>} items
 * @returns {string} '' when there is nothing to ground on
 */
export function buildProvenanceGroundingBlock(items) {
  const lines = [];
  for (const item of items) {
    if (item.policy === 'omit' || !item.value) continue;
    const plain = `${item.label}: ${item.value}`;
    const rendered = item.policy === 'hedge' ? hedgePhrase(plain, { date: item.validAt }) : plain;
    if (!rendered) continue;
    const tag = item.policy === 'assert' ? 'ASSERT' : 'HEDGE';
    lines.push(`- [${tag} | ${item.sourceClass}] ${item.entityName}: ${rendered}`);
  }
  if (!lines.length) return '';
  return `Provenance-tagged entity facts. ASSERT items are user-stated or from a real structured source — state them plainly. HEDGE items are model-inferred — keep the hedge phrasing verbatim and never state them as settled fact:\n${lines.join('\n')}`;
}

// The hardened contract Stage B adds on top of generateTopicContext()'s
// existing prompt (design §2.2 Stage B / §4.3). Deterministic, not model-
// authored — the same "hard constraint" register the rest of the prompt uses.
const HEDGE_CONTRACT = `Grounding discipline (hard constraint): every specific calendar date, headcount, or status claim you write must trace to a fact explicitly labeled ASSERT above, to a relationship fact from the entity graph, or to an explicit user correction. A claim whose only support is labeled HEDGE above, or that comes only from the narrative source material, must be phrased as uncertain ("appears to", "based on available signals") and must never be stated as a settled date or number. Never invent a date, name, status, or count that is not present in the material above.`;

function buildAssertHaystack(groundingItems, ctx) {
  const lines = groundingItems
    .filter((i) => i.policy === 'assert')
    .map((i) => `${i.label}: ${i.value}`);
  if (ctx.correctionText) lines.push(ctx.correctionText);
  if (ctx.graphFactsBlock) lines.push(ctx.graphFactsBlock);
  return lines.join('\n');
}

/**
 * Stage C validator: strip any date/number claim validateCardDatesAndNumbers
 * (lib/entity-card.js, chunk 3) flags as absent from the ASSERT-tier grounding
 * haystack. Redaction, not a fabricated replacement hedge — a wrong hedge
 * wrapper around an invented specific is still an invented specific; removing
 * it is the safe default (mirrors validateCardDatesAndNumbers' own
 * precision-favoring stance: ambiguity resolves toward accepting real data,
 * never toward inventing a substitute).
 *
 * @returns {{text:string, offending:string[]}}
 */
export function redactUngroundedClaims(text, assertHaystack) {
  const check = validateCardDatesAndNumbers(text, assertHaystack);
  if (check.ok) return { text: String(text || ''), offending: [] };
  let redacted = String(text || '');
  for (const claim of check.offending) {
    const escaped = claim.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    redacted = redacted.replace(new RegExp(escaped, 'g'), 'an unconfirmed detail');
  }
  return { text: redacted, offending: check.offending };
}

function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}

// ── The distiller ────────────────────────────────────────────────────────────

/**
 * Run the unified distiller for one topic. Three stages (see module docstring):
 * A — deterministic grounding, B — grounded Sonnet synthesis, C — the single
 * validated write through applyTopicContext().
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{slug?:string, workbenchId?:string}} target  one of the two required
 * @param {{dryRun?:boolean, repoRoot?:string, llm?:Function}} [opts]
 *   dryRun: true = compute and return everything, write NOTHING (no
 *     applyTopicContext call, no SYNTHESIS.md write, no projection-run record).
 *   llm: injectable Sonnet-call override for tests (synthesizeSummaryFromContext's
 *     convention) — omitted in production, where the real llmCreate fires.
 * @returns {Promise<Object|null>} null when the topic doesn't exist or has
 *   nothing to synthesize (same early-return generateTopicContext() has).
 */
export function distillShouldYieldToChat({ chatAppActive } = {}) {
  return chatAppActive === true;
}

export async function distillTopic(db, target = {}, opts = {}) {
  if (opts.yieldToChat === true || distillShouldYieldToChat(opts)) {
    return { skipped: true, reason: 'chat-app-open' };
  }
  const dryRun = Boolean(opts.dryRun);
  const repoRoot = opts.repoRoot || REPO_ROOT;

  let slug = target.slug || null;
  let workbench = target.workbenchId ? getWorkbench(db, target.workbenchId) : null;
  if (target.workbenchId && !workbench) {
    throw new Error(`distillTopic: workbench not found: ${target.workbenchId}`);
  }
  if (workbench && !slug) {
    const topicAttachment = (workbench.attachments || []).find((a) => a.target_type === 'topic');
    slug = topicAttachment?.target_id || null;
  }
  if (!slug) throw new Error('distillTopic: target.slug or target.workbenchId (with a topic attachment) is required');

  // Stage A(i) — the deterministic context-gathering generateTopicContext()
  // already had (RAG + entity files + graph facts + topic framing +
  // corrections) — same early-return semantics (null = nothing to synthesize).
  const ctx = await gatherTopicSynthesisContext(slug, db);
  if (!ctx) return null;

  // Stage A(ii) — workbench event-sourced replay, when a workbench is
  // registered for this topic. Read-only (collectWorkbenchSynthesisSources/
  // synthesizeDeterministically/formatSynthesisMarkdown never write). A topic
  // with no registered workbench simply skips this layer — entity/RAG/
  // correction grounding still grounds Stage B.
  if (!workbench) {
    try {
      // resolveWorkbench() returns a DIFFERENT payload shape (workbench_id,
      // root, no .items) than getWorkbench() (id, root_path, items) — the
      // shape collectWorkbenchSynthesisSources()/formatSynthesisMarkdown()
      // below actually need. Re-fetch the full row, mirroring
      // synthesizeWorkbench()'s own identical `workbench.items ? workbench :
      // getWorkbench(db, workbench.workbench_id)` fallback.
      const resolved = resolveWorkbench(db, { target: slug }, { repoRoot });
      workbench = resolved.items ? resolved : getWorkbench(db, resolved.workbench_id);
    } catch { workbench = null; }
  }
  let workbenchSources = [];
  let synthesisMarkdown = null;
  if (workbench) {
    try {
      workbenchSources = collectWorkbenchSynthesisSources(db, workbench, { repoRoot });
      const synthesis = synthesizeDeterministically(workbench, workbenchSources, repoRoot);
      const events = workbenchSources.filter((s) => s.event);
      const wbHash = sha256(stableJson(workbenchSources.map((s) => ({ kind: s.kind, source: s.source, hash: s.hash || '' }))));
      const formatted = formatSynthesisMarkdown({ workbench, synthesis, sources: workbenchSources, sourceHash: wbHash, events });
      synthesisMarkdown = formatted.markdown;
    } catch (e) {
      console.warn(`[topic-distill] workbench replay failed for ${slug} (non-fatal):`, e.message);
      workbenchSources = [];
      synthesisMarkdown = null;
    }
  }

  // Stage A(iii) — provenance-tagged entity_facts/entity_claims grounding.
  // Entity set = the RAG-linked entities gatherTopicSynthesisContext() already
  // resolved (ctx.entityIdList) UNION any person/company directly attached to
  // the topic's workbench (design §2.2 Stage A: "chunk_entities ... and
  // workbench attachments") — a topic can have a directly-attached entity with
  // no RAG-chunk link yet.
  const attachedEntityIds = (workbench?.attachments || [])
    .filter((a) => a.target_type === 'person' || a.target_type === 'company')
    .map((a) => a.target_id);
  const groundingEntityIds = Array.from(new Set([...(ctx.entityIdList || []), ...attachedEntityIds])).slice(0, 15);
  const groundingItems = collectEntityProvenanceGrounding(db, groundingEntityIds);
  const groundingBlock = buildProvenanceGroundingBlock(groundingItems);

  // The projection watermark — hashes everything Stage B is about to see.
  const sourceSetHash = sha256(stableJson({
    workbench: workbenchSources.map((s) => ({ kind: s.kind, source: s.source, hash: s.hash || '' })),
    grounding: groundingItems.map((i) => ({ entityId: i.entityId, kind: i.kind, label: i.label, value: i.value, sourceClass: i.sourceClass })),
    ragHash: sha256(ctx.ragText),
    entityHash: sha256(ctx.entityText),
    correctionHash: sha256(ctx.correctionText),
  }));

  // Stage B — grounded Sonnet synthesis: the identical prompt
  // generateTopicContext() uses, plus the provenance grounding block and the
  // hardened hedge contract.
  const summary = await synthesizeSummaryFromContext(ctx, {
    llm: opts.llm,
    extraGroundingBlock: groundingBlock,
    extraContract: HEDGE_CONTRACT,
  });

  // Stage C(i) — post-generation date/number validator (design §2.2 Stage C).
  const assertHaystack = buildAssertHaystack(groundingItems, ctx);
  const validated = redactUngroundedClaims(summary, assertHaystack);

  const summarySection = `## Summary\n\n${validated.text.trim().slice(0, TOPIC_SUMMARY_CHAR_BUDGET)}`;
  let context_md = summarySection;
  if (ctx.topicContextText) {
    context_md += `\n\n---\n\n## History\n\n### Topic framing (verbatim from canonical file)\n\n${ctx.topicContextText}`;
  }
  context_md += '\n';

  const identity = [ctx.label, firstLine(validated.text)].filter(Boolean).join(' — ').slice(0, TOPIC_IDENTITY_CHAR_BUDGET);

  const result = {
    slug,
    context_md,
    identity,
    tokens_used: Math.ceil(context_md.length / 4),
    source_set_hash: sourceSetHash,
    grounding_items: groundingItems.length,
    offending_redacted: validated.offending,
    workbench_id: workbench?.id || null,
    synthesis_path: null,
    applied: false,
    precedence_reason: null,
    memory_event_id: null,
    dry_run: dryRun,
  };

  if (dryRun) return result;

  // Stage C(ii) — the SINGLE write path (design §2.3): applyTopicContext(),
  // source='topic-distill' (precedence tier 3, lib/topic-context-apply.js) —
  // never a second direct UPDATE alongside it.
  const applied = await applyTopicContext(db, {
    slug,
    contextMd: context_md,
    sourceType: 'topic_distill',
    source: 'topic-distill',
    events: [{
      date: new Date().toISOString(),
      summary: `Topic distilled for ${ctx.label}`,
      metadata: { source_set_hash: sourceSetHash, grounding_items: groundingItems.length },
    }],
  });
  result.applied = applied.applied;
  result.precedence_reason = applied.precedence_reason;
  result.memory_event_id = applied.memory_event_id;

  // SYNTHESIS.md skeleton (Stage A) — only on a real run, only when a
  // workbench is registered; mirrors synthesizeWorkbench's own file write.
  if (workbench && synthesisMarkdown) {
    try {
      const synthesisPath = `${workbench.root_path}/SYNTHESIS.md`;
      const abs = resolve(repoRoot, synthesisPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, synthesisMarkdown);
      result.synthesis_path = toRepoPath(abs, repoRoot);
    } catch (e) {
      console.warn(`[topic-distill] SYNTHESIS.md write failed for ${slug} (non-fatal):`, e.message);
    }
  }

  recordProjectionRun(db, {
    projectionName: 'topic-distill',
    targetType: 'topic',
    targetId: slug,
    sourceEventFrom: null,
    sourceEventTo: null,
    sourceSetHash,
    projectionVersion: 'topic-distill-v1',
    promptVersion: 'grounded-hedge-v1',
    model: 'sonnet',
    generatedAt: new Date().toISOString(),
    generatedBy: 'topic-distill',
    outputHash: sha256(context_md),
    metadata: { grounding_items: groundingItems.length, workbench_id: workbench?.id || null },
  });

  return result;
}

/**
 * The dispatcher every call site (routes/api.js, scripts/maintenance-phases.js
 * TOPICS phase) should call instead of importing generateTopicContext directly.
 * Same return contract generateTopicContext() has ({context_md, tokens_used}
 * or null) so no caller needs an interface change either way.
 *
 * Flag OFF (default): delegates straight to the untouched generateTopicContext()
 * — zero behavior change. Flag ON: routes through distillTopic().
 *
 * @param {string} slug
 * @param {import('better-sqlite3').Database} db
 * @param {Object} [opts] forwarded to distillTopic() when the flag is on
 * @returns {Promise<{context_md:string, tokens_used:number}|null>}
 */
export async function distillOrGenerateTopicContext(slug, db, opts = {}) {
  if (!isTopicDistillEnabled()) return generateTopicContext(slug, db);
  const result = await distillTopic(db, { slug }, opts);
  if (!result) return null;
  return { context_md: result.context_md, tokens_used: result.tokens_used };
}
