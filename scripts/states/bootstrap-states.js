/**
 * bootstrap-states.js — One-time workbench setup for the States Project.
 *
 * Creates the `states` topic under `work`, provisions its default workbench
 * (wk_states), and ensures the Delaware source-docs directory tree exists
 * on disk. Idempotent: safe to run multiple times.
 *
 * WHY this exists: the States Project lives in the standard topic/workbench
 * hierarchy so topic context generation, RAG indexing, and chat all work out
 * of the box. This script wires that up deterministically before any fetch or
 * synthesis script runs.
 *
 * INTELLIGENCE_TIER: extraction — no LLM, deterministic DB writes only.
 *
 * Usage:
 *   cd ~/robotdojo && node scripts/states/bootstrap-states.js
 */
export const INTELLIGENCE_TIER = 'extraction';

import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

import db from '../../lib/db.js';
import { createTopic } from '../../lib/topics.js';
import { ensureDefaultTopicWorkbench } from '../../lib/workbenches.js';

// Repo root: this file lives at scripts/states/bootstrap-states.js, so two
// levels up is the repo root. Using import.meta.url is the ESM-safe approach.
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..');

// Delaware source-docs path (relative to repo root — matches the workbench
// root_path convention so the workbench scanner finds files here).
const DELAWARE_SOURCE_DOCS = 'user/workbenches/topics/work/states/wk_states/states/delaware/source-docs';

async function main() {
  // ── Step 1: Ensure `work` topic exists ──────────────────────────────────────
  // `work` is the T1 parent for robot-dojo, career, and states.
  // createTopic upserts safely, so this is idempotent.
  const workResult = createTopic(db, {
    slug: 'work',
    label: 'Work',
    parent_slug: null,
    visible: 1,
  });
  if (workResult.error) {
    // Validation errors mean the slug already exists with a different shape —
    // fine for an upsert. Only fatal if the error is unexpected.
    const existingWork = db.prepare('SELECT slug FROM user_topics WHERE slug = ?').get('work');
    if (!existingWork) {
      console.error('[states/bootstrap] Failed to create work topic:', workResult);
      process.exit(1);
    }
    // `work` already exists — proceed.
  }

  // ── Step 2: Create the `states` topic ───────────────────────────────────────
  const statesResult = createTopic(db, {
    slug: 'states',
    label: 'States Project',
    parent_slug: 'work',
    visible: 1,
  });
  if (statesResult.error) {
    const existing = db.prepare('SELECT slug FROM user_topics WHERE slug = ?').get('states');
    if (!existing) {
      console.error('[states/bootstrap] Failed to create states topic:', statesResult);
      process.exit(1);
    }
    // `states` topic already exists — idempotent, proceed.
  }

  // ── Step 3: Provision the default workbench ──────────────────────────────────
  // ensureDefaultTopicWorkbench returns the workbench row (existing or newly
  // created). It writes INDEX.md, LOG.md, SYNTHESIS.md to the root_path.
  let workbench;
  try {
    workbench = ensureDefaultTopicWorkbench(db, 'states');
  } catch (err) {
    console.error('[states/bootstrap] Failed to provision workbench:', err.message);
    process.exit(1);
  }

  // ── Step 4: Create Delaware source-docs directory tree ──────────────────────
  const delawareSrcDir = resolve(REPO_ROOT, DELAWARE_SOURCE_DOCS);
  mkdirSync(delawareSrcDir, { recursive: true });

  // ── Done ────────────────────────────────────────────────────────────────────
  console.log(JSON.stringify({
    ok: true,
    workbench_id: workbench.id,
    root: workbench.root_path,
    delaware_dir: DELAWARE_SOURCE_DOCS,
  }, null, 2));
}

main().catch(err => {
  console.error('[states/bootstrap] Unexpected error:', err);
  process.exit(1);
});
