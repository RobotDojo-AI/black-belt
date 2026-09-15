#!/usr/bin/env node
/**
 * Content Depth Scoring — rates iMessage conversation depth (0-10) via Haiku.
 *
 * Samples up to 10 recent iMessage chunks per person, sends to Haiku with a
 * depth rubric, stores the result in people.content_depth. The dp bonus in
 * lib/scoring.js uses this field — without it the bonus is always zero.
 *
 * CLI:
 *   node scripts/score-content-depth.js            # score up to 50
 *   node scripts/score-content-depth.js --limit 20
 */
import { getProvider } from '../lib/llm/index.js';
import { getModel } from '../lib/config.js';
import db from '../lib/db.js';

export const INTELLIGENCE_TIER = 'orchestration';

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 50;
const BATCH_SIZE = 20;

const SYSTEM = `You analyze text message conversations to determine relationship depth.

Rate the overall depth of the relationship on a 0-10 scale:

0-2: Surface — pure logistics, scheduling, "omw", forwarded links, group coordination
3-4: Casual — friendly but transactional, plans, recommendations, light banter
5-6: Meaningful — shared interests, career advice, genuine check-ins, personal updates
7-8: Deep — vulnerability, emotional support, health discussions, family struggles, life transitions
9-10: Intimate — raw honesty, deep personal struggles, mentorship, "I need your help with something hard"

Consider: emotional content vs logistics, personal struggles vs activities, reciprocal vulnerability, shared history, tone warmth.

Return ONLY a JSON object: {"score": <number 0-10>, "reason": "<one sentence>"}`;

const MODEL = getModel('anthropic', 'fast');

const candidates = db.prepare(`
  SELECT DISTINCT p.id, p.display_name, p.tier, p.score
  FROM people p
  WHERE p.imessage_msg_count > 10
    AND p.content_depth IS NULL
    AND COALESCE(p.archived, 0) = 0
  ORDER BY p.score DESC
`).all();

const getChunks = db.prepare(`
  SELECT content FROM chunks
  WHERE source_type = 'imessage'
    AND content LIKE ?
  ORDER BY ROWID DESC
  LIMIT 10
`);

const getAliases = db.prepare('SELECT alias FROM person_aliases WHERE person_id = ?');
const updateDepth = db.prepare('UPDATE people SET content_depth = ?, content_depth_samples = ? WHERE id = ?');

async function scoreOne(person) {
  const nameParts = person.display_name.split(' ');
  const patterns = [
    `%${person.display_name}%`,
    nameParts.length >= 2 ? `%${nameParts[0]} ${nameParts[nameParts.length - 1]}%` : null,
  ].filter(Boolean);

  let chunks = [];
  for (const pat of patterns) {
    chunks = getChunks.all(pat);
    if (chunks.length >= 2) break;
  }

  if (chunks.length < 2) {
    for (const { alias } of getAliases.all(person.id)) {
      if (alias.includes(' ')) {
        chunks = getChunks.all(`%${alias}%`);
        if (chunks.length >= 2) break;
      }
    }
  }

  if (chunks.length < 2) {
    updateDepth.run(0, 0, person.id);
    return { status: 'skipped' };
  }

  const combined = chunks
    .map((c, i) => `--- Sample ${i + 1} ---\n${c.content.slice(0, 500)}`)
    .join('\n\n');
  const prompt = `Here are ${chunks.length} iMessage exchanges involving "${person.display_name}". Rate the relationship depth.\n\n${combined}`;

  const resp = await (await getProvider('anthropic')).complete({
    model: MODEL,
    max_tokens: 128,
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  const cleaned = resp.content[0].text.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(cleaned);
  const score = Math.max(0, Math.min(10, parseFloat(parsed.score) || 0));
  updateDepth.run(score, chunks.length, person.id);
  return { status: 'scored', score, samples: chunks.length, reason: parsed.reason || '' };
}

const batch = candidates.slice(0, LIMIT);
console.log(`Content depth scoring: ${batch.length} people (${candidates.length} total pending)`);

let scored = 0, skipped = 0, failed = 0;

for (let i = 0; i < batch.length; i += BATCH_SIZE) {
  const slice = batch.slice(i, i + BATCH_SIZE);
  const results = await Promise.allSettled(slice.map(p => scoreOne(p)));

  for (let j = 0; j < slice.length; j++) {
    const person = slice[j];
    const r = results[j];
    if (r.status === 'rejected') {
      failed++;
      console.log(`  FAIL ${person.display_name}: ${r.reason?.message}`);
    } else if (r.value.status === 'skipped') {
      skipped++;
    } else {
      scored++;
      const { score, samples, reason } = r.value;
      const marker = score >= 7 ? '***' : score >= 4 ? ' **' : '   ';
      console.log(`  ${marker} ${person.display_name.padEnd(32)} depth=${score.toFixed(1)}  (${samples} samples)  ${reason}`);
    }
  }
  if (i + BATCH_SIZE < batch.length) {
    console.log(`  ${Math.min(i + BATCH_SIZE, batch.length)}/${batch.length}`);
  }
}

console.log(`\nScored: ${scored} | Skipped (no content): ${skipped} | Failed: ${failed}`);
if (candidates.length > LIMIT) {
  console.log(`Remaining: ${candidates.length - LIMIT} (run again or increase --limit)`);
}

if (scored > 0) {
  console.log('\n=== TOP DEPTH SCORES ===');
  const top = db.prepare(`
    SELECT display_name, content_depth, content_depth_samples, tier
    FROM people WHERE content_depth > 0
    ORDER BY content_depth DESC LIMIT 20
  `).all();
  for (const t of top) {
    console.log(`  ${t.content_depth.toFixed(1).padStart(4)}  ${t.display_name.padEnd(32)} ${t.tier}  (${t.content_depth_samples} samples)`);
  }
}
