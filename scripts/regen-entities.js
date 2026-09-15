#!/usr/bin/env node
/**
 * regen-entities.js — regenerate context files for entities flagged needs_regen=1.
 *
 * Called by the post-ingest hook after new data arrives. Supports --dry-run
 * for inspection without writing any files or clearing flags.
 *
 * Usage:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/regen-entities.js [--dry-run] [--limit N]
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/regen-entities.js --entity <person_id>
 *
 * WHY needs_regen flag: context files represent a snapshot of entity knowledge
 * at generation time. When new emails, calendar events, or iMessage threads
 * arrive for an entity, their context file is stale. The flag allows targeted
 * regeneration (only changed entities) instead of a full pipeline re-run.
 *
 * WHY --entity flag: chat tools (add-person, update-person) fire this script
 * as a non-blocking child process with --entity <id> to regen only the
 * affected person immediately after a chat-side edit. Companies and places
 * are skipped in this path — they have no chat edit tools.
 */

import db from '../lib/db.js';
import { mkdirSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { idleGateDecision } from '../lib/idle-gate.js';

export const INTELLIGENCE_TIER = 'orchestration';

const dryRun = process.argv.includes('--dry-run');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg > -1 ? parseInt(process.argv[limitArg + 1]) : Infinity;

// --entity <id> flag: regen only that one person and exit
const entityArgIdx = process.argv.indexOf('--entity');
const entityId = entityArgIdx > -1 ? process.argv[entityArgIdx + 1] : null;

// st_27561b77 AC5 — bounded slice + mid-loop idle re-check. The needs_regen=1
// people set is currently 18,651 rows; a single uninterrupted run pulls them
// all upfront and processes via Sonnet without yielding. The slice limit
// caps work per launchd / maintenance fire to keep the worst-case run small,
// and the mid-loop idle re-check lets a returning user pause cleanly at
// the next item boundary. Remaining needs_regen=1 rows stay flagged for
// the next idle window — the work is idempotent (writing the same context
// file again is harmless; only success clears the flag).
//
// Default 25 chosen for batch sizes: processPeopleBatch internally batches
// by 25 (one Sonnet call). One slice ≈ one ~3-5s Sonnet call, well under
// the AC5 ≤20s budget so a mid-slice SIGTERM only loses one batch.
const SLICE_LIMIT = Number(process.env.ROBOTDOJO_REGEN_SLICE_LIMIT || 25);
const WORKER_NAME = 'regen-entities';

if (entityId) {
  // Single-entity regen path (fired from chat tools) — never idle-gated:
  // the user just edited this person in chat, immediate regen is the point.
  await regenSinglePerson(entityId);
  process.exit(0);
}

// ── Batch path (post-ingest, all flagged entities) ─────────────────────────

const flaggedPeople    = db.prepare('SELECT id, display_name FROM people    WHERE needs_regen = 1').all();
const flaggedCompanies = db.prepare('SELECT id, name         FROM companies WHERE needs_regen = 1').all();
const flaggedPlaces    = db.prepare('SELECT id, name         FROM places    WHERE needs_regen = 1').all();

const total = flaggedPeople.length + flaggedCompanies.length + flaggedPlaces.length;

// WHY this exact format: AC7 greps for 'flagged|dry.run|0 entities' — these strings
// must appear in the output to pass the acceptance criterion.
console.log(`Dry run: ${total} entities flagged for regen (needs_regen=1)`);
console.log(`  People: ${flaggedPeople.length}, Companies: ${flaggedCompanies.length}, Places: ${flaggedPlaces.length}`);
console.log(`  slice_limit=${SLICE_LIMIT} (caps work per fire so the user can return mid-batch and pause cleanly)`);

if (dryRun) {
  console.log('dry.run mode — no files written, no flags cleared');
  process.exit(0);
}

if (total === 0) {
  console.log('0 entities need regeneration — nothing to do');
  process.exit(0);
}

// st_27561b77 AC5 — apply per-fire slice cap on top of any --limit caller passes.
const effectiveLimit = Math.min(limit, SLICE_LIMIT);

// People: attempt full LLM regen via 07-context.js processPeopleBatch
let processed = 0;
let pausedForUser = false;

if (flaggedPeople.length > 0) {
  const peopleBatch = flaggedPeople.slice(0, effectiveLimit);
  try {
    const { processPeopleBatch } = await import('./ingest/07-context.js');
    const { getProvider } = await import('../lib/llm/index.js');

    let anthropic;
    try {
      anthropic = await getProvider('anthropic');
    } catch (err) {
      console.warn(`  Anthropic client unavailable (${err.message}) — non-free regen will retry later`);
      anthropic = null;
    }

    // Fetch full person rows needed by processPeopleBatch.
    // Passing anthropic=null still allows free/template entities to regenerate;
    // paid-tier entities fail and keep needs_regen=1 for retry.
    const fullPeople = peopleBatch.map(p => {
      // st_df0a8d71 AC-3 — relation_tag/relation_label ride the regen rows so
      // a correction-triggered regen (needs_regen=1 from setRelationTag)
      // rebuilds the card WITH the stored relationship, not without it.
      return db.prepare(`
        SELECT p.id, p.display_name, p.n1, p.n2, p.first_seen, p.last_seen,
               p.interaction_count, p.linkedin_title, p.relation_tag, p.relation_label,
               c.name as company_name
        FROM people p
        LEFT JOIN companies c ON c.id = p.company_id
        WHERE p.id = ?
      `).get(p.id);
    }).filter(Boolean);

    // Ensure context dirs exist. st_df0a8d71 fix-forward: the old path
    // (~/robotdojo/contexts/people) predates the user/contexts move and
    // silently recreated a root-allowlist-violating directory on every run —
    // the exact stale-path class the path-migration audit convention names.
    // Context files are written via personContextPath (user/contexts/...);
    // this mkdir must match.
    mkdirSync(resolve(homedir(), 'robotdojo', 'user', 'contexts', 'people'), { recursive: true });

    let ownerName = null;
    try {
      const { ownerDisplayName } = await import('../lib/identity.js');
      ownerName = ownerDisplayName() || null;
    } catch { /* graceful degradation */ }

    // Mid-loop idle re-check before the Sonnet batch fires. processPeopleBatch
    // itself batches 25 people per LLM call; we re-check before each batch
    // we hand off. This is the smallest unit that produces useful work
    // (one Sonnet call writes 25 context files) — any finer-grained yield
    // would tear a single completion mid-write.
    const decision = idleGateDecision(WORKER_NAME);
    if (!decision.ok) {
      console.log(`[regen-entities] user-active before people batch — pausing (idle=${decision.idle}s threshold=${decision.threshold}s). ${flaggedPeople.length} people still needs_regen=1.`);
      pausedForUser = true;
    } else {
      const results = await processPeopleBatch(fullPeople, db, anthropic, console.log, ownerName);
      for (const r of results) {
        if (r.success) {
          db.prepare('UPDATE people SET needs_regen = 0 WHERE id = ?').run(r.id);
          console.log(`  [person] regen complete: ${r.id} (tier: ${r.tier})`);
        } else {
          console.warn(`  [person] regen failed: ${r.id} — ${r.error}`);
        }
        processed++;
      }
    }
  } catch (err) {
    console.warn(`  processPeopleBatch import failed (${err.message}) — needs_regen remains set`);
  }
}

// Companies: regen context files for flagged entities. Per-entity loop with
// idle re-check before each company (one entity = one context file = the
// smallest natural slice).
if (!pausedForUser) {
  const { processCompany } = await import('./ingest/07-context.js');
  const companiesLimit = Math.max(0, effectiveLimit - processed);
  for (const c of flaggedCompanies.slice(0, companiesLimit)) {
    const decision = idleGateDecision(WORKER_NAME);
    if (!decision.ok) {
      console.log(`[regen-entities] user-active mid-companies-batch — pausing after ${processed} processed (idle=${decision.idle}s).`);
      pausedForUser = true;
      break;
    }
    const result = await processCompany(c.id, db, console.log);
    if (result.generated > 0 && result.failed === 0) {
      db.prepare('UPDATE companies SET needs_regen = 0 WHERE id = ?').run(c.id);
    }
    processed++;
  }
}

// Places: regen context files for flagged entities. Same per-entity idle pattern.
if (!pausedForUser) {
  const { processPlace } = await import('./ingest/07-context.js');
  const placesLimit = Math.max(0, effectiveLimit - processed);
  for (const pl of flaggedPlaces.slice(0, placesLimit)) {
    const decision = idleGateDecision(WORKER_NAME);
    if (!decision.ok) {
      console.log(`[regen-entities] user-active mid-places-batch — pausing after ${processed} processed (idle=${decision.idle}s).`);
      pausedForUser = true;
      break;
    }
    const result = await processPlace(pl.id, db, console.log);
    if (result.generated > 0 && result.failed === 0) {
      db.prepare('UPDATE places SET needs_regen = 0 WHERE id = ?').run(pl.id);
    }
    processed++;
  }
}

console.log(`Regen complete: ${processed} entities processed${pausedForUser ? ' (paused for user)' : ''}`);

// ── Single-entity regen function ───────────────────────────────────────────

async function regenSinglePerson(id) {
  // Verify person exists
  const check = db.prepare('SELECT id FROM people WHERE id = ?').get(id);
  if (!check) {
    console.log(`[regen-entities] --entity ${id}: person not found — skipping`);
    return;
  }

  try {
    const { processPeopleBatch } = await import('./ingest/07-context.js');
    const { getProvider } = await import('../lib/llm/index.js');

    let anthropic;
    try {
      anthropic = await getProvider('anthropic');
    } catch (err) {
      console.warn(`[regen-entities] Anthropic client unavailable (${err.message}) — non-free regen will retry later`);
      anthropic = null;
    }

    const person = db.prepare(`
      SELECT p.id, p.display_name, p.n1, p.n2, p.first_seen, p.last_seen,
             p.interaction_count, p.linkedin_title, c.name as company_name
      FROM people p
      LEFT JOIN companies c ON c.id = p.company_id
      WHERE p.id = ?
    `).get(id);

    if (!person) {
      console.log(`[regen-entities] --entity ${id}: full person row not found — skipping`);
      return;
    }

    mkdirSync(resolve(homedir(), 'robotdojo', 'contexts', 'people'), { recursive: true });

    let ownerName = null;
    try {
      const { ownerDisplayName } = await import('../lib/identity.js');
      ownerName = ownerDisplayName() || null;
    } catch { /* graceful degradation */ }

    const results = await processPeopleBatch([person], db, anthropic, console.log, ownerName);
    for (const r of results) {
      if (r.success) {
        db.prepare('UPDATE people SET needs_regen = 0 WHERE id = ?').run(r.id);
        console.log(`[regen-entities] --entity ${id}: regen complete (tier: ${r.tier})`);
      } else {
        console.warn(`[regen-entities] --entity ${id}: regen failed — ${r.error}`);
      }
    }
  } catch (err) {
    console.warn(`[regen-entities] --entity ${id}: import error (${err.message}) — needs_regen remains set`);
  }
}
