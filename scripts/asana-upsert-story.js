#!/usr/bin/env node
/**
 * asana-upsert-story.js
 * Upsert a single story from its local meta.json + scope doc to the Asana Miyagi Build board.
 * Called automatically on: new story creation, every stage gate approval, build start, close.
 *
 * Usage: node scripts/asana-upsert-story.js --story <story_id>
 *        node scripts/asana-upsert-story.js --help
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import https from 'node:https';
import path from 'node:path';
import { ARTIFACTS } from './pipeline-schema.js';
import { loadAsanaRoutingConfig } from '../lib/asana-routing-config.js';

// ── CLI ────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
asana-upsert-story.js — upsert a local story to the Asana Miyagi Build board

Usage:
  node scripts/asana-upsert-story.js --story <story_id>

Options:
  --story <id>   Story directory name under ~/robotdojo/stories/ (e.g. st_3f8ec87a)
  --help         Show this help

Reads:
  ~/robotdojo/stories/<story_id>/meta.json   slug, kanban stage, description, asana_gid
  ~/robotdojo/stories/<story_id>/00-scope.md  title (h1) + Acceptance Criteria section

Writes back:
  meta.json asana_gid field if a new task is created

Section GIDs (Backlog/Next/In Progress/Done) are hard-coded constants.
Board has 4 sections only: Backlog → Next → In Progress → Done.

Exit codes:
  0  success
  1  error (missing story, API failure, etc.)
`);
  process.exit(0);
}

const storyIdx = args.indexOf('--story');
if (storyIdx === -1 || !args[storyIdx + 1]) {
  console.error('ERROR: --story <story_id> is required. Run with --help for usage.');
  process.exit(1);
}
const STORY_ID = args[storyIdx + 1];

// ── Config ────────────────────────────────────────────────────────────────────

const HOME = process.env.HOME;
// Workspace gid, build-board project gid, and section gids ALL come from
// config/asana-routing.json (df_e1dcf732 AC9 — one source of truth; NO gid
// literals in scripts/). The tracked config ships placeholders; the owner's real
// build board + section gids live in the gitignored config/asana-routing.user.json
// override (boards.build). This script is a disabled no-op unless
// ROBOTDOJO_ENABLE_ASANA_SYNC=1, so a fresh clone with placeholder gids never
// reaches the Asana calls.
const _asanaCfg     = loadAsanaRoutingConfig();
const PROJECT_GID   = _asanaCfg.boards.build.project;
const WORKSPACE_GID = _asanaCfg.destinations.default.workspace;

// Section GIDs for the four stable sections (Backlog/Next/In Progress/Done).
const SECTION_GIDS = {
  backlog:      _asanaCfg.boards.build.sections.backlog,
  next:         _asanaCfg.boards.build.sections.next,
  'in-progress':_asanaCfg.boards.build.sections['in-progress'],
  done:         _asanaCfg.boards.build.sections.done,
};

// ── PAT ───────────────────────────────────────────────────────────────────────

function getPAT() {
  if (process.env.ASANA_PAT) return process.env.ASANA_PAT;
  try {
    return execSync('security find-generic-password -s "robotdojo-ASANA_PAT" -a "miyagi" -w', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    console.error('ERROR: Could not retrieve Asana PAT from Keychain.');
    console.error('  Run: security add-generic-password -s "robotdojo-ASANA_PAT" -a "miyagi" -w "<pat>"');
    console.error('  Or:  export ASANA_PAT="<pat>" in ~/.zshrc');
    process.exit(1);
  }
}

// ── Asana HTTP helpers ────────────────────────────────────────────────────────

function asanaRequest(method, apiPath, body, pat) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify({ data: body }) : undefined;
    const options = {
      hostname: 'app.asana.com',
      path: `/api/1.0${apiPath}`,
      method,
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Asana API ${res.statusCode}: ${JSON.stringify(parsed?.errors || parsed).slice(0, 200)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`JSON parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Scope doc parser ──────────────────────────────────────────────────────────

function parseScopeDoc(scopePath) {
  if (!existsSync(scopePath)) {
    return { title: null, acceptanceCriteria: null };
  }

  const content = readFileSync(scopePath, 'utf8');
  const lines = content.split('\n');

  // Extract h1 title
  let title = null;
  for (const line of lines) {
    const m = line.match(/^#\s+(.+)/);
    if (m) {
      title = m[1].trim();
      break;
    }
  }

  // Extract Acceptance Criteria section (numbered items)
  let inAC = false;
  const acLines = [];
  for (const line of lines) {
    if (/^##\s+(acceptance criteria)/i.test(line)) {
      inAC = true;
      continue;
    }
    if (inAC) {
      // Stop at next ##-level heading
      if (/^##\s/.test(line)) break;
      // Collect numbered items (1. ... or 1) ...)
      if (/^\d+[\.\)]\s/.test(line.trim())) {
        acLines.push(line.trim());
      }
    }
  }

  return {
    title,
    acceptanceCriteria: acLines.length > 0 ? acLines : null,
  };
}

// ── Kanban stage → section key ────────────────────────────────────────────────
// Board has 4 sections. Internal pipeline stages (scoping, scoped) map to Backlog
// until research is approved — once research starts, story moves to In Progress.

function kanbanToSectionKey(kanban, stageHashes) {
  if (kanban === 'done') return 'done';
  if (kanban === 'in-progress') return 'in-progress';
  if (kanban === 'next') {
    // If research has been approved, it's actively being worked → In Progress
    const researchApproved = stageHashes?.chain?.research?.owner_approved;
    return researchApproved ? 'in-progress' : 'next';
  }
  // backlog, scoping, scoped — all map to Backlog until promoted to next
  return 'backlog';
}

// ── Task notes builder ────────────────────────────────────────────────────────

function buildNotes(description, acceptanceCriteria, slug) {
  const whatLine = `**What:** ${description || 'See scope doc.'}`;

  let donePart;
  if (acceptanceCriteria && acceptanceCriteria.length > 0) {
    donePart = `**Done when:**\n${acceptanceCriteria.join('\n')}`;
  } else {
    donePart = '**Done when:**\nTBD — not yet scoped';
  }

  const slugLine = `**Local slug:** ${slug}`;

  return `${whatLine}\n\n${donePart}\n\n${slugLine}`;
}

// ── DE-LINKED (owner directive 2026-06-06) ──────────────────────────────────
// The old Robot Dojo kanban board was replaced by the current phase-based
// project, so local kanban is no longer mirrored to Asana by default. This sync
// is retained as a no-op so any lingering trigger exits cleanly without making
// Asana API calls.
if (process.env.ROBOTDOJO_ENABLE_ASANA_SYNC !== '1') {
  console.log('asana sync disabled — kanban is not mirrored to the current phase-based Asana board');
  process.exit(0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const storyDir = path.join(HOME, 'robotdojo', 'user', 'workbenches', 'topics', 'work', 'robot-dojo', 'wk_robot_dojo', 'stories', STORY_ID);

  if (!existsSync(storyDir)) {
    console.error(`ERROR: Story directory not found: ${storyDir}`);
    process.exit(1);
  }

  const metaPath = path.join(storyDir, 'meta.json');
  if (!existsSync(metaPath)) {
    console.error(`ERROR: meta.json not found: ${metaPath}`);
    process.exit(1);
  }

  const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  const { slug, kanban, description, short_desc, type: storyType, asana_gid: existingGID, tags } = meta;

  if (!slug) {
    console.error('ERROR: meta.json is missing required field: slug');
    process.exit(1);
  }

  // Load stage-hashes to detect research approval (→ In Progress even if kanban is 'next')
  const stageHashesPath = path.join(storyDir, 'stage-hashes.json');
  const stageHashes = existsSync(stageHashesPath)
    ? JSON.parse(readFileSync(stageHashesPath, 'utf8'))
    : null;

  const scopePath = path.join(storyDir, ARTIFACTS.scope);
  const { title: scopeTitle, acceptanceCriteria } = parseScopeDoc(scopePath);

  const typePrefix = storyType === 'defect' ? 'Defect:' : 'Story:';
  const displayDesc = short_desc || (slug || '').replace(/-/g, ' ');
  const tagPrefix = (tags && tags.length > 0) ? tags.map(t => `[${t}]`).join(' ') + ' ' : '';
  const taskName = `${tagPrefix}${typePrefix} ${displayDesc}`;
  const notes = buildNotes(description, acceptanceCriteria, slug);
  const sectionKey = kanbanToSectionKey(kanban || 'backlog', stageHashes);

  const pat = getPAT();
  const sectionGID = SECTION_GIDS[sectionKey];
  if (!sectionGID) {
    console.error(`ERROR: No section GID for key '${sectionKey}' (kanban: '${kanban}')`);
    process.exit(1);
  }

  console.log(`${STORY_ID} | ${slug} | ${kanban} → ${sectionKey} | ACs: ${acceptanceCriteria?.length ?? 0}`);

  let taskGID;

  if (existingGID) {
    // PATCH existing task
    console.log(`\nPatching existing task ${existingGID}...`);
    const patchBody = {
      name: taskName,
      notes,
      "completed": kanban === 'done',
    };
    await asanaRequest('PUT', `/tasks/${existingGID}`, patchBody, pat);
    taskGID = existingGID;
    console.log(`  Updated: name + notes${kanban === 'done' ? ' + completed' : ''}`);
  } else {
    // POST new task
    console.log(`\nCreating new task in project ${PROJECT_GID}...`);
    const created = await asanaRequest('POST', '/tasks', {
      name: taskName,
      notes,
      projects: [PROJECT_GID],
      workspace: WORKSPACE_GID,
      resource_subtype: 'milestone',
    }, pat);
    taskGID = created.data.gid;
    console.log(`  Created: ${taskGID}`);

    // Write GID back to meta.json
    meta.asana_gid = taskGID;
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    console.log(`  Wrote asana_gid back to meta.json`);
  }

  // Move to correct section
  console.log(`Moving to section '${sectionKey}' (${sectionGID})...`);
  await asanaRequest('POST', `/sections/${sectionGID}/addTask`, { task: taskGID }, pat);
  console.log(`  Done.`);

  console.log(`\nAsana upsert complete: https://app.asana.com/0/${PROJECT_GID}/${taskGID}`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  process.exit(1);
});
