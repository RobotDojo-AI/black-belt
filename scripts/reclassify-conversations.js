#!/usr/bin/env node
/**
 * Reclassify conversations against the live user_topics list.
 *
 * Compute tier ladder:
 *   Tier 0  inferTopicFromContent (keyword) — free, runs first per conversation
 *   Tier 1  Haiku classifyIntent — fires only when Tier 0 misses
 *   Tier 0  generateTopicEmbedding (post-context) — free, feeds future Round 2
 *
 * Flags:
 *   --dry-run   log candidate count and exit; no writes
 *   --all       reclassify every non-user-set conversation
 *               (default: only topic_slug IS NULL OR topic_set_method = 'keyword')
 *
 * Invocation: ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/reclassify-conversations.js [--dry-run] [--all]
 */
import db from '../lib/db.js';
import { classifyConversationTopic } from '../lib/conversations.js';
import { generateTopicContext, generateTopicEmbedding, suggestTopicLabel } from '../lib/topic-context.js';

const isDryRun = process.argv.includes('--dry-run');
const isAll = process.argv.includes('--all');

async function run() {
  const query = isAll
    ? "SELECT id FROM conversations WHERE (topic_set_method IS NULL OR topic_set_method != 'user') ORDER BY created_at DESC"
    : "SELECT id FROM conversations WHERE (topic_slug IS NULL OR topic_set_method = 'keyword') AND (topic_set_method IS NULL OR topic_set_method != 'user') ORDER BY created_at DESC";

  const candidates = db.prepare(query).all();

  if (isDryRun) {
    console.log(`[reclassify] dry-run: ${candidates.length} candidates, no writes`);
    process.exit(0);
  }

  console.log(`[reclassify] classifying ${candidates.length} conversations…`);

  let classified = 0;
  const affectedTopics = new Set();

  for (const { id } of candidates) {
    try {
      const ok = await classifyConversationTopic(db, id);
      if (ok) {
        classified++;
        const row = db.prepare('SELECT topic_slug FROM conversations WHERE id = ?').get(id);
        if (row?.topic_slug) affectedTopics.add(row.topic_slug);
        // Pick up secondary topics too — those should also see context regen
        const secondaries = db.prepare("SELECT topic_slug FROM conversation_topics WHERE conversation_id = ? AND is_primary = 0").all(id);
        for (const s of secondaries) affectedTopics.add(s.topic_slug);
      }
    } catch (e) {
      console.error(`[reclassify] error for ${id}:`, e.message);
    }
  }

  console.log(`[reclassify] round 1 done: ${classified} classified, ${affectedTopics.size} topics affected`);

  // Regenerate context + embedding + suggested label for each affected topic.
  // generateTopicContext is the slow leg (Sonnet, ~3s/topic); the embedding +
  // label suggestion are cheap follow-ups that depend on its output.
  for (const slug of affectedTopics) {
    try {
      await generateTopicContext(slug, db);
      await generateTopicEmbedding(slug, db);
      await suggestTopicLabel(slug, db);
      console.log(`[reclassify] context regenerated: ${slug}`);
    } catch (e) {
      console.error(`[reclassify] context error for ${slug}:`, e.message);
    }
  }

  console.log('[reclassify] done');
}

run().catch(err => {
  console.error('[reclassify] fatal:', err);
  process.exit(1);
});
