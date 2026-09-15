#!/usr/bin/env node
/**
 * scripts/spend-surface.js — what can spend money without you asking?
 *
 * st_4312c9c0. The ledger answers "what did it cost." The tier policy answers
 * "at what model." Neither answers the question that actually produced a $1,239
 * surprise: WHICH CODE PATHS CAN SPEND WITHOUT AN EXPLICIT ASK, and what bounds
 * them when they do.
 *
 * Every call site is classified by TRIGGER:
 *
 *   autonomous  fires with no human in the loop — a timer, a sync, a backlog
 *               drain. This is the class that produces surprise invoices,
 *               because nobody is watching when it runs.
 *   reactive    fires on an action the owner took — a chat turn, a dropped
 *               file. Bounded by his own activity; one action, one small call.
 *   explicit    only ever runs when he invokes it — a CLI script or a skill.
 *
 * The report shows each path, its trigger, its lane, and the ceiling that stops
 * it. Autonomous + unbounded is the dangerous combination and is called out.
 *
 * Usage: node scripts/spend-surface.js [--json]
 */

// INTELLIGENCE_TIER: extraction — deterministic classification over the policy
// and the source tree. Makes no model call.
export const INTELLIGENCE_TIER = 'extraction';

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const policy = JSON.parse(readFileSync(join(REPO_ROOT, 'config/tier-policy.json'), 'utf8'));
const limits = JSON.parse(readFileSync(join(REPO_ROOT, 'config/spend-limits.json'), 'utf8'));

/**
 * How each spending path is reached. Hand-classified because the trigger is a
 * fact about the RUNTIME (what invokes it, on what schedule), which no static
 * scan can infer — an import edge does not tell you whether the importer is a
 * launch agent, a request handler, or a CLI entrypoint.
 *
 * `bulk: true` marks a path that iterates a corpus rather than handling one
 * item. Bulk + autonomous is the combination that produced the invoice.
 */
const TRIGGERS = {
  'lib/entity-enrich.js': {
    trigger: 'autonomous', bulk: true,
    how: 'passive-reconciler + chunk-worker drain the enrichment backlog; policy is bb_active_default_on, so it runs unless ROBOTDOJO_OWNER_BOX_DISABLE_ENRICHMENT=1',
  },
  'lib/attribute-residual.js': {
    trigger: 'autonomous', bulk: true,
    how: 'granola-sync (every 5 min) attributes speakers the deterministic matcher could not settle',
  },
  'lib/granola-call-asana.js': {
    trigger: 'autonomous', bulk: false,
    how: 'granola-sync (every 5 min) summarises each new transcript into an Asana task',
  },
  'lib/topic-context.js': {
    trigger: 'autonomous', bulk: false,
    how: 'topic-edit-watcher (60s) regenerates a topic summary when needs_regen is set',
  },
  'lib/topic-session.js': {
    trigger: 'autonomous', bulk: false,
    how: 'one resume synthesis per expired topic session (idle, tab close, leave-topic); not a corpus sweep',
  },
  'scripts/ingest/07-context.js': {
    trigger: 'autonomous', bulk: true,
    how: 'the entity pipeline generates context cards for every qualifying person, company and place',
  },
  'lib/entity-card.js': {
    trigger: 'reactive', bulk: false,
    how: 'chat-context assembles cards for entities in the current conversation',
  },
  'lib/context-router.js': {
    trigger: 'reactive', bulk: false,
    how: 'one routing call per chat prompt — the highest-frequency site by count',
  },
  'lib/doc-extract.js': {
    trigger: 'reactive', bulk: false, how: 'a file dropped into the inbox folder is extracted',
  },
  'lib/doc-classify.js': {
    trigger: 'reactive', bulk: false, how: 'a dropped file is classified by type',
  },
  'lib/receipt-extract.js': {
    trigger: 'reactive', bulk: false, how: 'a dropped receipt image is parsed',
  },
  'lib/health-pdf-ocr.js': {
    trigger: 'reactive', bulk: false, how: 'OCR fallback when a lab PDF has no text layer',
  },
  'lib/public-chat/core.js': {
    trigger: 'reactive', bulk: false, how: 'a stranger uses the marketing chat; rate-limited',
  },
  'routes/chat.js': {
    trigger: 'reactive', bulk: false, how: 'the owner sends a chat message',
  },
  'lib/conversations.js': {
    trigger: 'reactive', bulk: false, how: 'a conversation is titled or reclassified',
  },
  'lib/chat-tools/white/assistant-mention.js': {
    trigger: 'reactive', bulk: false, how: 'an @-mention inside a chat turn is resolved',
  },
  'lib/profile-research.js': {
    trigger: 'explicit', bulk: false,
    how: '/profile, and the followup sweep — fetches the web, then synthesises a profile',
  },
  'lib/followup-sweep.js': {
    trigger: 'explicit', bulk: false, how: '/followup on a named person or company',
  },
  'lib/health-intel.js': {
    trigger: 'explicit', bulk: false,
    how: 'owner-triggered health regeneration; auto-regen is off unless ROBOTDOJO_HEALTH_INTEL_AUTO_REGEN=1',
  },
  'lib/health-coach.js': {
    trigger: 'reactive', bulk: false,
    how: 'Fitness photo or constraint chat; daily meal and workout plans are deterministic and do not call a model',
  },
  'lib/health-marker-copy.js': {
    trigger: 'explicit', bulk: true, how: 'per-marker copy, regenerated with health intel',
  },
  'lib/voice-ingest.js': {
    trigger: 'explicit', bulk: false, how: 'ingest-voices, run by hand',
  },
  'lib/writing.js': {
    trigger: 'reactive', bulk: false,
    how: 'web apply_voice and /write generate a Miyagi reply or nested owner draft on the owner turn',
  },
  'lib/generate-user-md.js': {
    trigger: 'explicit', bulk: false, how: 'generate-user-md, run by hand',
  },
  'lib/identity-distill.js': {
    trigger: 'explicit', bulk: false, how: 'distill-identity, run by hand',
  },
  'lib/workbench-promote-entities.js': {
    trigger: 'explicit', bulk: false, how: 'workbench promotion, reviewed',
  },
  'scripts/memory-synthesize.js': {
    trigger: 'explicit', bulk: false, how: 'run by hand; writes agents/agents.md',
  },
  'scripts/synthesize-brief.js': {
    trigger: 'explicit', bulk: false, how: 'run by hand; writes the world brief',
  },
  'scripts/states/delaware-model.js': {
    trigger: 'explicit', bulk: false, how: 'valuation script, run by hand',
  },
  'scripts/ingest/adjudicate-email-classification.js': {
    trigger: 'explicit', bulk: true, how: 'email adjudication over the residual, run by hand',
  },
  'scripts/classify-places.js': { trigger: 'explicit', bulk: true, how: 'bulk place classification, run by hand' },
  'scripts/enrich-places.js': { trigger: 'explicit', bulk: true, how: 'bulk place enrichment, run by hand' },
  'scripts/extract-all-pdfs.js': { trigger: 'explicit', bulk: true, how: 'bulk PDF extraction, run by hand' },
  'scripts/import-pdf-labs.js': { trigger: 'explicit', bulk: true, how: 'lab PDF import, run by hand' },
  'scripts/import-pdf-labs-batch.js': { trigger: 'explicit', bulk: true, how: 'batch lab import, run by hand' },
  'lib/quarantine/tier-1/index.js': { trigger: 'explicit', bulk: true, how: 'quarantined; not on a live path' },
};

const args = { json: process.argv.includes('--json') };
const sites = policy.app_call_sites || {};
const rows = [];
const unclassified = [];

for (const [path, spec] of Object.entries(sites)) {
  const t = TRIGGERS[path];
  if (!t) { unclassified.push(path); continue; }
  rows.push({ path, lane: spec.max_lane, category: spec.category, ...t });
}

const order = { autonomous: 0, reactive: 1, explicit: 2 };
rows.sort((a, b) => (order[a.trigger] - order[b.trigger]) || a.path.localeCompare(b.path));

const autonomousBulk = rows.filter((r) => r.trigger === 'autonomous' && r.bulk);

if (args.json) {
  process.stdout.write(`${JSON.stringify({
    daily_pipeline_ceiling_usd: limits.daily_usd?.pipeline,
    daily_total_ceiling_usd: limits.daily_usd?.total,
    monthly_ceiling_usd: limits.monthly_usd?.total,
    autonomous_bulk_paths: autonomousBulk.map((r) => r.path),
    sites: rows,
    unclassified,
  }, null, 2)}\n`);
  process.exit(unclassified.length ? 1 : 0);
}

const cap = limits.daily_usd?.pipeline;
process.stdout.write(`Spend surface — ${rows.length} paths that can bill the API key\n`);
process.stdout.write(`Every one is bounded by the $${cap} daily background ceiling `);
process.stdout.write(`($${limits.daily_usd?.total} including chat, $${limits.monthly_usd?.total}/month).\n\n`);

let current = null;
for (const r of rows) {
  if (r.trigger !== current) {
    current = r.trigger;
    const heading = {
      autonomous: 'AUTONOMOUS — runs with nobody watching. The class that produces surprise invoices.',
      reactive: 'REACTIVE — one small call per action you take. Bounded by your own activity.',
      explicit: 'EXPLICIT — only runs when you invoke it.',
    }[current];
    process.stdout.write(`\n${heading}\n`);
  }
  process.stdout.write(`  ${r.bulk ? '[BULK] ' : '       '}${r.path.padEnd(46)} ${String(r.lane).padEnd(9)} ${r.how}\n`);
}

process.stdout.write('\n');
if (autonomousBulk.length) {
  process.stdout.write(`${autonomousBulk.length} path(s) are BOTH autonomous AND bulk — they iterate a corpus with nobody watching:\n`);
  for (const r of autonomousBulk) process.stdout.write(`  - ${r.path}\n`);
  process.stdout.write(`These are what a $${cap}/day ceiling exists to bound. Without it one pass over\n`);
  process.stdout.write('this corpus runs to completion unmetered, which is how the invoice happened.\n');
}
if (unclassified.length) {
  process.stdout.write(`\nUNCLASSIFIED (${unclassified.length}) — a new spending path with no declared trigger:\n`);
  for (const p of unclassified) process.stdout.write(`  - ${p}\n`);
  process.stdout.write('Add it to TRIGGERS in this file. A path nobody classified is a path nobody bounded.\n');
  process.exit(1);
}
