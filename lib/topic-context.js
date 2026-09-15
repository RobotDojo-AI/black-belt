/**
 * Topic context synthesis — generates living, source-grounded topic reads.
 *
 * generateTopicContext(slug, db):
 *   1. Load topic label + description from user_topics
 *   2. RAG: retrieve(label + ' ' + description, { limit: 300 })
 *   3. Entity context: for each entity linked to RAG results, load context file
 *   4. Sonnet synthesis → living topic read
 *   5. Write context_md to user_topics + log to topic_context_history
 *
 * Model: claude-sonnet-4-6 — synthesis quality matters, not Haiku.
 * Budget: TOPIC_SUMMARY_CHAR_BUDGET = 4000 chars (~1K tokens) for the
 *   `## Summary` section chat injects by default; the verbatim canonical
 *   topic-framing file is preserved whole below the fold under `## History`
 *   (st_2cd1af73 Phase 5).
 *
 * Tier notes (compute tier protocol):
 *   Tier 0: RAG retrieval (embeddings similarity — free)
 *   Tier 2: Sonnet synthesis on the pre-filtered corpus
 *   Haiku (Tier 1) skipped here — this is a targeted synthesis call on
 *   a small corpus, not a bulk classification pass.
 *
 * Fire-and-forget usage: PUT /api/topics/:slug calls this without await.
 * Awaited usage: POST /api/topics/:slug/context/refresh waits for result.
 *
 * WHY separate module: synthesis logic is reusable across routes without
 * polluting the route files with API call and DB write concerns.
 *
 * gatherTopicSynthesisContext() / synthesizeSummaryFromContext() (design-
 * unified-architecture.md §2.3, st_5184eb86): the context-gathering (RAG +
 * entity files + graph facts + topic framing + corrections) and the
 * prompt-assembly + Sonnet call are split out of generateTopicContext() below
 * into their own exported functions so lib/topic-distill.js's Stage B can
 * reuse the SAME narrative-quality prompt instead of duplicating it — one
 * source of synthesis logic, two write paths. generateTopicContext() itself
 * is unchanged behavior: it calls both in sequence and keeps its own direct
 * UPDATE write (untouched — the cutover to the guarded write path is gated
 * behind the topic_distill flag in lib/topic-distill.js, not done here).
 *
 * INTELLIGENCE_TIER = 'synthesis' (reads structure, calls Sonnet, writes
 * canonical markdown only — see build-conventions.md LLM write boundary).
 */
export const INTELLIGENCE_TIER = 'synthesis';

import { retrieve } from './rag/retrieve.js';
import { llmCreate } from './llm-gateway.js';
import { EMBED_DIM, EMBED_MODEL, contentHash, embedBatch, embeddingSignature, vectorToBuffer } from './rag.js';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelFor } from './model-lane.js';
import {
  entityContextPath,
  topicContextPath as packageTopicContextPath,
} from './context-paths.js';
import { listViewerCorrections } from './viewer-corrections.js';
import { relationPhrase } from './relation-vocabulary.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// st_2cd1af73 Phase 5: the SUMMARY section target dropped 12000 → 4000. The
// synthesized summary is now the `## Summary` block chat injects by default; a
// tight ~4k card beats a force-filled 12k dump (the old prompt literally asked
// the model to "Fill approximately 12000 characters", padding with filler the
// injector then truncated). The verbatim canonical topic-framing file is no
// longer crammed inside this 12k cap — it moves below a `---` under `## History`
// (kept whole), so the 4k target governs only the synthesis summary.
// Runtime constant, not a canonical-surfaces.json entry; overridable via
// config/defaults.json chat_injection.per_topic_chars.
let TOPIC_SUMMARY_CHAR_BUDGET = 4000;
try {
  const _d = JSON.parse(readFileSync(join(__dirname, '../config/defaults.json'), 'utf8'));
  TOPIC_SUMMARY_CHAR_BUDGET = _d.chat_injection?.per_topic_chars ?? 4000;
} catch {}

// Summary/History markers — the same contract lib/chat-context.js parses and
// scripts/ingest/07-context.js writes for entities. Topic context_md now carries
// the identical split so the topic injector can inject the summary by default.
const SUMMARY_HEADING = '## Summary';
const HISTORY_HEADING = '## History';

async function queueHealthIntelForTopicContext(slug, reason) {
  if (slug !== 'health') return null;
  return {
    job: null,
    alreadyRunning: false,
    queued: false,
    skipped: true,
    reason,
    detail: 'derived topic context synthesis is not a material health intel input',
  };
}

/**
 * Generate (or regenerate) the synthesized context_md for a topic.
 *
 * @param {string} slug - user_topics.slug
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{context_md: string, tokens_used: number}|null>}
 *   null if topic not found or has no description.
 */
/**
 * Gather every deterministic context input for a topic's living synthesis:
 * RAG corpus, linked entity context files, graph-fact lines (relation_tag
 * SOURCE TRUTH), the canonical topic-framing file, and viewer corrections.
 * This is exactly generateTopicContext()'s former steps 1-3b, split out
 * (design-unified-architecture.md §2.3) so both the direct-write engine below
 * AND lib/topic-distill.js's Stage B call the identical gathering logic.
 *
 * @param {string} slug
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<Object|null>} null when the topic doesn't exist or has
 *   nothing to synthesize (same early-return cases generateTopicContext had).
 */
export async function gatherTopicSynthesisContext(slug, db) {
  // 1. Load topic from DB
  const topic = db.prepare('SELECT label, description, parent_slug FROM user_topics WHERE slug = ?').get(slug);
  if (!topic) return null;

  const { label, description, parent_slug } = topic;

  // T1 groups (parent_slug IS NULL) have programmatic context derived from child topics.
  // They represent "everything [Work/Personal/etc] not covered by a specific subtopic."
  // Manual description is not required — children define the specifics.
  const isGroup = parent_slug === null || parent_slug === undefined;
  let effectiveDescription = description?.trim() || '';
  if (isGroup) {
    const children = db.prepare(
      "SELECT label FROM user_topics WHERE parent_slug = ? AND visible = 1 ORDER BY sort_order, label"
    ).all(slug);
    if (children.length === 0 && !effectiveDescription) return null;
    const childNames = children.map(c => c.label).join(', ');
    const specificPart = childNames
      ? `Specific subtopics handled separately: ${childNames}.`
      : '';
    effectiveDescription = `General ${label} context — everything ${label}-related not covered by a specific subtopic. ${specificPart}`.trim();
  } else if (!effectiveDescription) {
    // T2 topic with no description: nothing to synthesize
    return null;
  }

  // 2. RAG: retrieve corpus chunks relevant to this topic
  // st_f0adee6f raised the limit from 25 → 300 and added a 0.65 score floor
  // so synthesis sees a wider corpus while filtering out weak matches.
  let ragText = '';
  const entityIds = new Set();
  try {
    const ragQuery = [label, effectiveDescription].filter(Boolean).join(' ');
    const result = await retrieve(ragQuery, { limit: 300 });
    if (!result.insufficient && result.results?.length) {
      // Score floor: drop weak matches before stitching into ragText.
      const filtered = result.results.filter(r => typeof r.score !== 'number' || r.score >= 0.65);
      // Each result has: id (chunk_id), content, topic, score, source_type, source_id
      ragText = filtered.map(r => r.content || '').filter(Boolean).join('\n\n');

      // Collect entity_ids from chunk_entities for context file loading
      for (const r of filtered) {
        if (r.id) {
          try {
            const links = db.prepare('SELECT entity_id FROM chunk_entities WHERE chunk_id = ?').all(r.id);
            links.forEach(l => entityIds.add(l.entity_id));
          } catch { /* chunk_entities may not be populated */ }
        }
      }
    }
  } catch (e) {
    // RAG failure is non-fatal — synthesis continues with description only
    console.warn('[topic-context] RAG failed:', e.message);
  }

  // 3. Entity context files — load canonical package files for linked people/companies.
  //
  // st_d142f701 AC15: two bugs fixed.
  //   (a) The query was `SELECT name FROM people` but the `people` schema
  //       column is `display_name`. The wrong column silently returned
  //       undefined inside the try/catch, so the entity layer was always
  //       empty — no entity context ever reached the prompt.
  //   (b) The manual slug `person.name.toLowerCase().replace(...)` produced
  //       `john-doe`, but entity packages on disk use the canonical format
  //       from lib/context-paths.js:entityPackageNameFromDisplay which is
  //       `john-doe--{entityShortId(id)}`. Even with the schema fix, the
  //       lookup would miss the real file.
  // Switch to `entityContextPath(type, id, db)` so the path matches what
  // the package writer produces. Try `person` first, fall back to
  // `company` if the entity id is for a company.
  let entityText = '';
  // st_df0a8d71 AC-3 — graph-facts constraint block. For every relation-tagged
  // (first-degree) person surfacing in this topic's entity layer, the stored
  // graph relationship is stated to the synthesizer as SOURCE TRUTH that
  // outranks any RAG narrative — a topic card can no longer carry a
  // relationship claim that contradicts the graph.
  const graphFactLines = [];
  const entityIdList = Array.from(entityIds).slice(0, 10); // cap at 10 to keep prompt manageable
  for (const entityId of entityIdList) {
    try {
      const person = db.prepare('SELECT display_name, relation_tag, relation_label, relation_derived_phrase FROM people WHERE id = ?').get(entityId);
      const company = person ? null : db.prepare('SELECT name FROM companies WHERE id = ?').get(entityId);
      const displayName = person?.display_name || company?.name;
      if (!displayName) continue;
      if (person?.relation_tag) {
        // st_f67bc2eb AC-2 — walk-derived phrase first ("wife's cousin").
        graphFactLines.push(`- ${displayName} is the user's ${person.relation_derived_phrase || relationPhrase(person.relation_tag, person.relation_label)}.`);
      }
      const entityType = person ? 'person' : 'company';
      const packagePath = join(__dirname, '..', entityContextPath(entityType, entityId, db));
      if (existsSync(packagePath)) {
        entityText += `\n### ${displayName}\n${readFileSync(packagePath, 'utf8').slice(0, 2000)}\n`;
      }
    } catch { /* entity lookup failure is non-fatal */ }
  }
  const graphFactsBlock = graphFactLines.length
    ? `Relationship facts from the entity graph (SOURCE TRUTH — state these plainly where relevant and never contradict, soften, or re-infer them from the narrative material):\n${graphFactLines.join('\n')}`
    : '';

  // 3b. Topic context file — st_4a7d6b1f. Closes the orphan loop where
  //     user/contexts/topics/{parent_slug}/{slug}/context.md is hand-curated but never
  //     read into chat preamble. Additive only; existing entity-card reads
  //     above are untouched. Missing file (most topics) → silent no-op.
  let topicContextText = '';
  if (parent_slug && !isGroup) {
    try {
      const topicCtxPath = join(__dirname, '..', packageTopicContextPath(db, slug));
      if (existsSync(topicCtxPath)) {
        // Cap matches the canonical-surfaces.json max_chars for topic files
        // (coaching.md = 8000, health.md = 10000); read up to 10000 to cover
        // the largest registered topic. Combined-output cap below.
        topicContextText = readFileSync(topicCtxPath, 'utf8').slice(0, 10000);
      }
    } catch (e) {
      // Missing-file / read-error is non-fatal — auto-regen continues
      // without the topic-file layer.
      console.warn('[topic-context] topic file read failed:', e.message);
    }
  }

  let correctionText = '';
  try {
    correctionText = listViewerCorrections(db, {
      targetType: 'topic',
      targetId: slug,
      limit: 20,
    })
      .map((correction) => `- ${correction.valid_at || 'unknown time'}: ${correction.summary}`)
      .filter(Boolean)
      .join('\n');
  } catch (e) {
    console.warn('[topic-context] viewer corrections read failed:', e.message);
  }

  return {
    slug, label, parent_slug, isGroup, effectiveDescription,
    ragText, entityText, graphFactsBlock, topicContextText, correctionText,
    // entityIdList: the same RAG-linked entity ids (chunk_entities), capped at
    // 10, that fed entityText/graphFactsBlock above — exposed so
    // lib/topic-distill.js's Stage A can ground on entity_facts/entity_claims
    // for the SAME entity set instead of re-running the RAG retrieval.
    entityIdList,
  };
}

/**
 * Build the narrative-synthesis prompt from a gathered context and call
 * Sonnet — generateTopicContext()'s former step 4, split out so
 * lib/topic-distill.js's Stage B can call the SAME prompt template with an
 * extra provenance-grounding block and hedge contract appended, rather than
 * duplicating the ~30-line prompt (Carmack: duplication is a maintenance
 * burden waiting to drift).
 *
 * @param {Object} ctx                    from gatherTopicSynthesisContext()
 * @param {Object} [options]
 * @param {Function} [options.llm]        injectable `(args) => {content}` override for
 *                                        tests (buildEntityCardSummary's convention) —
 *                                        defaults to the real llmCreate/modelFor('balanced') call.
 * @param {string} [options.extraGroundingBlock] additional provenance-labeled
 *   fact/claim lines (topic-distill's Stage A grounding) inserted alongside
 *   graphFactsBlock — empty for generateTopicContext's own callers.
 * @param {string} [options.extraContract]       additional prompt instructions
 *   appended before the closing "Generate the Summary body only" contract
 *   (topic-distill's hedge contract) — empty for generateTopicContext.
 * @returns {Promise<string>} the synthesized summary text (or effectiveDescription
 *   on synthesis failure — same fallback generateTopicContext always had).
 */
export async function synthesizeSummaryFromContext(ctx, options = {}) {
  const { llm, extraGroundingBlock = '', extraContract = '' } = options;
  const { label, isGroup, effectiveDescription, graphFactsBlock, ragText, entityText, topicContextText, correctionText } = ctx;

  // 4. Sonnet synthesis — T1 groups get a catch-all framing; T2 topics get specific framing
  const promptIntro = isGroup
    ? `You are generating a living topic read for a private topic CATEGORY called "${label}".
This category is a catch-all — it handles everything ${label}-related not covered by more specific subtopics.
${effectiveDescription}`
    : `You are generating a living topic read for a private topic page.

Topic: ${label}
User's framing: ${effectiveDescription}`;

  const prompt = `${promptIntro}

${graphFactsBlock}
${extraGroundingBlock}
${ragText ? `Source material from the user's actual history:\n${ragText.slice(0, 80000)}` : ''}
${entityText ? `People and relationship material:\n${entityText.slice(0, 3000)}` : ''}
${topicContextText ? `Canonical topic framing (preserve every load-bearing sentence, every quoted phrase, and any verbatim marker tokens such as "_marker_<id>_" lines exactly as written; do not paraphrase the framing layer):\n${topicContextText}` : ''}
${correctionText ? `Explicit user corrections to rendered topic projections. Treat these as source truth and resolve conflicts in favor of them:\n${correctionText}` : ''}
${extraContract}

Generate the Summary body only. No heading.
The user should feel the topic as a live part of their world, not as a database readout.

Cover:
- The current read: what this topic means now
- The user's role, taste, posture, and recurring pattern inside it
- The people, relationships, organizations, tensions, or decisions that give it weight
- Active work, open loops, next anchors, and what would matter if the user reopened this tomorrow

Write in second person ("You are..."). Use precise, human prose. Bullets are allowed only when the source material is operational; otherwise use paragraphs.
Avoid labels like "executive summary", "database", "record", "context system", "corpus", or "structured data".
Keep it under ${TOPIC_SUMMARY_CHAR_BUDGET} characters. Make every sentence useful — no filler, no hedging, no padding to hit a length. Stop when the read is complete.`;

  let summary = '';
  try {
    const response = llm
      ? await llm({
          model: modelFor('balanced'),
          max_tokens: 3000,
          messages: [{ role: 'user', content: prompt }],
        })
      : await llmCreate({
          model: modelFor('balanced'),
          max_tokens: 3000,
          messages: [{ role: 'user', content: prompt }],
        }, 'topic-context');
    summary = response.content[0]?.text || '';
  } catch (e) {
    // Synthesis failure: fall back to effective description
    console.warn('[topic-context] Sonnet synthesis failed:', e.message);
    summary = effectiveDescription;
  }
  return summary;
}

/**
 * Generate (or regenerate) the synthesized context_md for a topic.
 *
 * @param {string} slug - user_topics.slug
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{context_md: string, tokens_used: number}|null>}
 *   null if topic not found or has no description.
 */
export async function generateTopicContext(slug, db) {
  const ctx = await gatherTopicSynthesisContext(slug, db);
  if (!ctx) return null;
  const summary = await synthesizeSummaryFromContext(ctx);
  const { topicContextText } = ctx;

  // st_2cd1af73 Phase 5: write the Summary/History split.
  //   ## Summary — the synthesized exec summary, ≤4k, the section chat injects
  //                by default. Capped here so the injector's 4k budget is the
  //                whole summary, never a mid-sentence truncation.
  //   ## History — the verbatim canonical topic-framing file (st_4a7d6b1f kept
  //                its load-bearing sentences and authored markers reaching the
  //                prompt). It moves BELOW the fold and is kept WHOLE — it is no
  //                longer crammed into the summary budget. Read on demand.
  const summarySection = `${SUMMARY_HEADING}\n\n${String(summary).trim().slice(0, TOPIC_SUMMARY_CHAR_BUDGET)}`;
  let context_md = summarySection;
  if (topicContextText) {
    context_md += `\n\n---\n\n${HISTORY_HEADING}\n\n### Topic framing (verbatim from canonical file)\n\n${topicContextText}`;
  }
  context_md += '\n';

  // 5. Write to DB — direct UPDATE (unchanged; the cutover to the guarded
  // applyTopicContext() write path is gated behind the topic_distill flag in
  // lib/topic-distill.js, not touched here — st_5184eb86 chunk 5 safety spine).
  db.prepare("UPDATE user_topics SET context_md = ?, updated_at = datetime('now') WHERE slug = ?")
    .run(context_md, slug);

  // Log to history — topic_context_history tracks synthesis runs for debugging/audit.
  // The table uses (id INTEGER AUTOINCREMENT, topic_slug, content, source, created_at).
  // WHY log: lets us diff context versions and trace synthesis failures over time.
  db.prepare(`INSERT INTO topic_context_history (topic_slug, content, source, created_at)
    VALUES (?, ?, ?, datetime('now'))`)
    .run(slug, context_md, 'synthesis');

  await queueHealthIntelForTopicContext(slug, 'health_topic_context_regenerated');
  const tokens_used = Math.ceil(context_md.length / 4);
  return { context_md, tokens_used };
}

/**
 * Generate and store an embedding for a topic's identity text (label +
 * description + context_md). Used by Round 2 reclassification — at runtime
 * we score conversation chunks against these embeddings via cosine similarity
 * to discover secondary topic assignments without further Haiku calls.
 *
 * Tier 0 (free): embed once after context synthesis. No per-classification cost.
 *
 * @param {string} slug
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<Float32Array|null>} the embedding vector, or null on failure / missing topic
 */
export async function generateTopicEmbedding(slug, db) {
  const topic = db.prepare('SELECT label, description, context_md FROM user_topics WHERE slug = ?').get(slug);
  if (!topic) return null;
  const text = [topic.label, topic.description, topic.context_md].filter(Boolean).join('\n').slice(0, 8000);
  if (!text.trim()) return null;
  try {
    const vecs = await embedBatch([text], 1, null, { inputType: 'document' });
    const vec = vecs?.[0];
    if (!vec) return null;
    const hash = contentHash(text);
    const signature = embeddingSignature({ content_hash: hash, topic: slug, modelId: EMBED_MODEL, dim: EMBED_DIM });
    const buf = vectorToBuffer(vec);
    db.prepare(`
      UPDATE user_topics
         SET description_embedding = ?,
             description_embedding_model_id = ?,
             description_embedding_dim = ?,
             description_embedding_signature = ?,
             description_embedding_at = datetime('now')
       WHERE slug = ?
    `).run(buf, EMBED_MODEL, EMBED_DIM, signature, slug);
    return vec;
  } catch (e) {
    console.warn('[topic-context] generateTopicEmbedding failed for', slug, ':', e.message);
    return null;
  }
}

/**
 * Ask Haiku whether the topic's current label is a good fit for its synthesized
 * context_md. If Haiku suggests a better short label, store it in suggested_label
 * for the user to review. Never auto-applies — user remains in control.
 *
 * @param {string} slug
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<string|null>} the suggested label, or null if current label is fine / unavailable
 */
export async function suggestTopicLabel(slug, db) {
  const topic = db.prepare('SELECT label, context_md FROM user_topics WHERE slug = ?').get(slug);
  if (!topic || !topic.context_md) return null;

  const prompt = `The user has a topic currently labeled "${topic.label}". Below is the synthesized context describing what this topic actually contains:

${topic.context_md.slice(0, 6000)}

Suggest a single short label (2-4 words) that better describes this topic than the current label. If the current label is already a good fit, reply with exactly the word NONE.

Reply with the suggested label only, no quotes, no punctuation, no explanation.`;

  let suggestion = null;
  try {
    const response = await llmCreate({
      model: modelFor('fast'),
      max_tokens: 30,
      messages: [{ role: 'user', content: prompt }],
    }, 'topic-context-suggest-label');
    suggestion = (response.content?.[0]?.text || '').trim();
  } catch (e) {
    console.warn('[topic-context] suggestTopicLabel failed for', slug, ':', e.message);
    return null;
  }

  if (!suggestion || suggestion.toUpperCase() === 'NONE') return null;
  // Reject obviously low-quality suggestions (too long, identical to current)
  if (suggestion.length > 60) return null;
  if (suggestion.toLowerCase() === topic.label.toLowerCase()) return null;

  db.prepare('UPDATE user_topics SET suggested_label = ? WHERE slug = ?').run(suggestion, slug);
  return suggestion;
}
