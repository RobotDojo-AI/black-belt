#!/usr/bin/env node
// scripts/distill-identity.js — run identity distillation against the user's
// corpus and (optionally) append supersedes to the identity log.
//
// Usage:
//   node scripts/distill-identity.js --dry-run        # gather + distill, print cards
//   node scripts/distill-identity.js --apply           # append supersedes
//   node scripts/distill-identity.js --skip <source>   # e.g. --skip email
//
// Writes the full proposed JSON to /tmp/identity-distill-<ts>.json for review.

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gatherCorpus, distill, CARDS, TOPIC_SLUGS } from '../lib/identity-distill.js';
import { appendIdentitySection } from '../lib/identity-log.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DRY_RUN = !APPLY || args.includes('--dry-run');
const skipIdx = args.indexOf('--skip');
const SKIP = skipIdx >= 0 ? (args[skipIdx + 1] || '').split(',').filter(Boolean) : [];

const sources = {};
for (const s of SKIP) sources[s] = false;

async function main() {
  console.log('[distill] gathering corpus…');
  const bundles = await gatherCorpus({ sources });
  for (const b of bundles) {
    const chars = b.items.reduce((s, i) => s + (i.body || '').length, 0);
    console.log(`  ${b.name.padEnd(16)} items=${String(b.items.length).padEnd(5)} chars=${chars}`);
  }

  console.log('\n[distill] calling model (Claude Opus)…');
  const t0 = Date.now();
  const res = await distill({ corpus: bundles });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[distill] model returned in ${dt}s; input=${res.usage.input_tokens} tok, output=${res.usage.output_tokens} tok`);

  const outPath = resolve(tmpdir(), `identity-distill-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify({ ...res, generated: new Date().toISOString() }, null, 2));
  console.log(`[distill] full output saved to ${outPath}\n`);

  if (res.notes) {
    console.log('MODEL NOTES:');
    console.log('  ' + res.notes.replace(/\n/g, '\n  '));
    console.log();
  }

  for (const c of CARDS) {
    const body = res.cards[c.id] || '';
    const bytes = Buffer.byteLength(body, 'utf8');
    console.log(`\n${'='.repeat(72)}\n# ${c.id}  (${c.verb})  — ${bytes} bytes  [TIMELESS]\n${'='.repeat(72)}\n${body}\n`);
  }

  console.log(`\n${'#'.repeat(72)}\n# TOPIC CONTEXTS (time-bounded, load only when topic is active)\n${'#'.repeat(72)}`);
  const topicSlugs = Object.keys(res.topics || {});
  if (!topicSlugs.length) {
    console.log('  (no topic-context signal extracted)');
  }
  for (const slug of topicSlugs) {
    const body = res.topics[slug];
    const bytes = Buffer.byteLength(body, 'utf8');
    console.log(`\n--- topic: ${slug} — ${bytes} bytes ---\n${body}\n`);
  }

  if (!APPLY) {
    console.log('\n[distill] --dry-run: nothing written. Re-run with --apply to append supersedes to the identity log.');
    return;
  }

  console.log('\n[distill] --apply: appending supersedes…');
  for (const c of CARDS) {
    const body = (res.cards[c.id] || '').trim();
    if (!body) { console.log(`  - ${c.id}: empty, skipping`); continue; }
    const r = await appendIdentitySection({
      section: c.id, body,
      description: `Distilled from corpus (${res.bundles.map((b) => b.name).join(', ')})`,
      author: 'distill',
    });
    console.log(`  ✓ ${c.id.padEnd(12)} ${r.name}`);
  }
  console.log('[distill] cards applied. Topic-context bodies NOT auto-written — review above and apply via update_context chat tool or a separate step (coming soon).');
}

main().catch((err) => {
  console.error('[distill] error:', err.message);
  process.exit(1);
});
