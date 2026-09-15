#!/usr/bin/env node
/**
 * sync-asana.js
 * Upserts every robotdojo story into the Asana kanban project.
 * Usage: node scripts/sync-asana.js
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';
import { loadAsanaRoutingConfig } from '../lib/asana-routing-config.js';

// ── Config ────────────────────────────────────────────────────────────────────
// Workspace gid, build-board project gid, and section gids ALL come from
// config/asana-routing.json (df_e1dcf732 AC9 — one source of truth; NO gid
// literals in scripts/). The tracked config ships placeholders; the owner's real
// build board + section gids live in the gitignored config/asana-routing.user.json
// override (boards.build). This script is a disabled no-op unless
// ROBOTDOJO_ENABLE_ASANA_SYNC=1, so a fresh clone with placeholder gids never
// reaches the Asana calls below.

const ASANA_BASE = 'https://app.asana.com/api/1.0';
const _asanaCfg = loadAsanaRoutingConfig();
const WORKSPACE_GID = _asanaCfg.destinations.default.workspace;
const PROJECT_GID = _asanaCfg.boards.build.project;
const _buildSections = _asanaCfg.boards.build.sections;

if (process.env.ROBOTDOJO_ENABLE_ASANA_SYNC !== '1') {
  console.log('asana sync disabled — local kanban is not mirrored to the current phase-based Asana board');
  process.exit(0);
}

const SECTION_MAP = {
  backlog: _buildSections.backlog,
  scoped: _buildSections.next,
  scoping: _buildSections.next, // treat like next/scoped
  next: _buildSections.next,
  'in-progress': _buildSections['in-progress'],
  done: _buildSections.done,
  archived: _buildSections.done,
};

const STORIES_DIR = PIPELINE_STORIES_DIR;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getPAT() {
  if (process.env.ASANA_PAT) return process.env.ASANA_PAT;
  try {
    return execSync('security find-generic-password -s "robotdojo-ASANA_PAT" -a "miyagi" -w', {
      encoding: 'utf8',
    }).trim();
  } catch {
    console.error('ERROR: Could not read robotdojo-ASANA_PAT from keychain.');
    console.error('  Or:  export ASANA_PAT="<pat>" in ~/.zshrc');
    process.exit(1);
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function asana(pat, method, path, body) {
  const res = await fetch(`${ASANA_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Asana ${method} ${path} → ${res.status}: ${text}`);
  }

  // 204 No Content (addTask) returns no body
  if (res.status === 204) return null;
  const json = await res.json();
  return json.data;
}

// ── Story loading ─────────────────────────────────────────────────────────────

function loadStories() {
  const entries = readdirSync(STORIES_DIR);
  const stories = [];

  for (const entry of entries) {
    if (entry === 'index.md') continue;
    const dir = join(STORIES_DIR, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const metaPath = join(dir, 'meta.json');
    let meta;
    try {
      meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    } catch {
      // no meta.json — skip
      continue;
    }

    // Derive a stable ID and name regardless of meta shape
    const story_id =
      meta.story_id ||
      meta.id ||
      entry; // fall back to directory name

    const story_name =
      meta.story_name ||
      meta.slug ||
      meta.title ||
      entry;

    const kanban = (meta.kanban || 'backlog').toLowerCase();
    const description = meta.description || meta.title || '';
    const stage = meta.stage || '';
    const verdict = meta.verdict || null;
    const started = meta.started || meta.created_at || meta.date || '';
    const asana_gid = meta.asana_gid || null;
    const type = meta.type || 'story';
    const short_desc = meta.short_desc || null;

    stories.push({
      _metaPath: metaPath,
      _meta: meta,
      story_id,
      story_name,
      kanban,
      description,
      stage,
      verdict,
      started,
      asana_gid,
      type,
      short_desc,
    });
  }

  return stories;
}

// ── Task builders ─────────────────────────────────────────────────────────────

function taskName(story) {
  const prefix = story.type === 'defect' ? 'Defect:' : 'Story:';
  const displayDesc = story.short_desc || (story.story_name || '').replace(/-/g, ' ');
  return `${prefix} ${displayDesc}`;
}

function taskNotes(story) {
  return [
    story.description,
    '',
    `Stage: ${story.stage}`,
    `Verdict: ${story.verdict || '—'}`,
    `Started: ${story.started}`,
  ].join('\n');
}

function sectionGid(kanban) {
  return SECTION_MAP[kanban] || SECTION_MAP['backlog'];
}

// ── Upsert ────────────────────────────────────────────────────────────────────

async function upsertStory(pat, story) {
  const name = taskName(story);
  const notes = taskNotes(story);
  const secGid = sectionGid(story.kanban);

  if (story.asana_gid) {
    // UPDATE existing task
    await asana(pat, 'PUT', `/tasks/${story.asana_gid}`, {
      data: { name, notes },
    });
    await delay(100);

    // Move to correct section
    await asana(pat, 'POST', `/sections/${secGid}/addTask`, {
      data: { task: story.asana_gid },
    });
    await delay(100);

    console.log(`[ upsert ] ${story.story_id} → ${story.asana_gid}`);
    return { action: 'upsert', gid: story.asana_gid };
  } else {
    // CREATE new task
    const created = await asana(pat, 'POST', '/tasks', {
      data: {
        name,
        notes,
        projects: [PROJECT_GID],
        workspace: WORKSPACE_GID,
        resource_subtype: 'milestone',
      },
    });
    await delay(100);

    const gid = created.gid;

    // Move to section
    await asana(pat, 'POST', `/sections/${secGid}/addTask`, {
      data: { task: gid },
    });
    await delay(100);

    // Persist GID back to meta.json
    const updated = { ...story._meta, asana_gid: gid };
    writeFileSync(story._metaPath, JSON.stringify(updated, null, 2) + '\n');

    console.log(`[ create ] ${story.story_id} → ${gid}`);
    return { action: 'create', gid };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const pat = getPAT();
  const stories = loadStories();

  console.log(`Syncing ${stories.length} stories to Asana…`);

  let failed = 0;

  for (const story of stories) {
    try {
      await upsertStory(pat, story);
    } catch (err) {
      console.error(`[ ERROR ] ${story.story_id}: ${err.message}`);
      failed++;
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} story(ies) failed.`);
    process.exit(1);
  }

  console.log('\nDone.');
  process.exit(0);
}

main();
