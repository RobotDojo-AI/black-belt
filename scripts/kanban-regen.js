#!/usr/bin/env node
/**
 * kanban-regen.js
 * Regenerates the Execution clusters section of kanban.md from live meta.json state.
 * Preserves all agent-synthesized narrative sections.
 *
 * Usage: node ~/robotdojo/scripts/kanban-regen.js
 *
 * Env:
 *   ROBOTDOJO_STORIES_DIR — override stories directory (for testing)
 */

import { readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { PIPELINE_STORIES_DIR, PIPELINE_KANBAN_PATH } from '../lib/robotdojo-paths.js';

// --- Config ---
const STORIES_DIR = PIPELINE_STORIES_DIR;

const KANBAN_FILE = PIPELINE_KANBAN_PATH;

// Status emoji
const STATUS_EMOJI = {
  'in-progress': '🔄',
  'done': '✅',
};
function statusEmoji(kanban) {
  return STATUS_EMOJI[kanban] || '⬜';
}

// Statuses to exclude from the board
const EXCLUDE_KANBAN = new Set(['done', 'cancelled', 'archived']);

// --- Load stories ---
function loadStories() {
  let entries;
  try {
    entries = readdirSync(STORIES_DIR);
  } catch (err) {
    process.stderr.write(`Error: stories dir not readable: ${STORIES_DIR}\n`);
    process.exit(1);
  }

  const stories = [];
  for (const entry of entries) {
    if (!/^(st|df|wk)_/.test(entry)) continue;
    const metaPath = join(STORIES_DIR, entry, 'meta.json');
    try {
      const raw = readFileSync(metaPath, 'utf8');
      const meta = JSON.parse(raw);
      stories.push(meta);
    } catch (err) {
      process.stderr.write(`Warning: skipping malformed meta.json at ${metaPath}: ${err.message}\n`);
    }
  }
  return stories;
}

// --- Group stories into clusters (per-tag) ---
function buildClusters(stories) {
  // Filter: exclude done/cancelled/archived
  const active = stories.filter(s => !EXCLUDE_KANBAN.has(s.kanban));

  // Within each terminal: in-progress first, then by started date
  function sortStories(arr) {
    return arr.slice().sort((a, b) => {
      const aActive = a.kanban === 'in-progress' ? 0 : 1;
      const bActive = b.kanban === 'in-progress' ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return (a.started || '').localeCompare(b.started || '');
    });
  }

  // Build terminal clusters for a set of stories
  function buildTerminalClusters(storySet) {
    const byTerminal = { A: [], B: [], unassigned: [] };
    for (const s of storySet) {
      const t = s.terminal;
      if (t === 'A') byTerminal.A.push(s);
      else if (t === 'B') byTerminal.B.push(s);
      else byTerminal.unassigned.push(s);
    }
    const clusters = [];
    if (byTerminal.A.length > 0) {
      clusters.push({ label: 'Terminal A', stories: sortStories(byTerminal.A) });
    }
    if (byTerminal.B.length > 0) {
      clusters.push({ label: 'Terminal B', stories: sortStories(byTerminal.B) });
    }
    if (byTerminal.unassigned.length > 0) {
      clusters.push({ label: 'Backlog', stories: sortStories(byTerminal.unassigned) });
    }
    return clusters;
  }

  // Group stories by domain — undefined → 'robotdojo' (the legacy default
  // — see st_c5e0de43 plan; per-record domain backfill is out of scope).
  // The pivot from tags[0] to meta.domain locks the kanban grouping primitive
  // to the schema-required field; tags-as-domain was a transitional convention.
  const byDomain = {};
  for (const s of active) {
    const domain = s.domain || 'robotdojo';
    if (!byDomain[domain]) byDomain[domain] = [];
    byDomain[domain].push(s);
  }

  // Build per-domain cluster groups — 'robotdojo' first, then alphabetical
  const tagGroups = [];
  const domainKeys = Object.keys(byDomain).sort((a, b) => {
    if (a === 'robotdojo') return -1;
    if (b === 'robotdojo') return 1;
    return a.localeCompare(b);
  });

  for (const domain of domainKeys) {
    const clusters = buildTerminalClusters(byDomain[domain]);
    if (clusters.length > 0) {
      tagGroups.push({ tag: domain, clusters });
    }
  }

  return tagGroups;
}

// --- Render a single tag group's clusters to markdown ---
function renderClusters(clusters) {
  const lines = [];
  for (const cluster of clusters) {
    lines.push(`**${cluster.label}**`);
    lines.push('');
    for (const s of cluster.stories) {
      const terminal = s.terminal || '—';
      const size = s.size || '?';
      const slug = (s.slug || s.story_name || '').slice(0, 35);
      const status = statusEmoji(s.kanban);
      lines.push(`${terminal} ${s.story_id} ${size} ${slug} ${status}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// --- Render all tag groups to markdown (returns array of {tag, markdown} objects) ---
function renderTagGroups(tagGroups) {
  return tagGroups.map(({ tag, clusters }) => ({
    tag,
    markdown: renderClusters(clusters),
  }));
}

// --- Parse existing kanban.md to extract preserved sections ---
function parseKanban(content) {
  const sectionNames = [
    'Current goal',
    'Where we are',
    'Open questions',
    'Strategic context',
    'Product',
    "What doesn't change",
    'Cancelled',
  ];

  const sections = {};
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const sectionMatch = line.match(/^## (.+)$/);
    if (sectionMatch) {
      const name = sectionMatch[1].trim();
      // Skip all machine-generated Queue sections (bare "Queue" or "Queue — *")
      if (name === 'Queue' || name.startsWith('Queue — ')) {
        i++;
        while (i < lines.length && !lines[i].match(/^## /)) {
          i++;
        }
        continue;
      }
      if (sectionNames.includes(name)) {
        i++;
        const body = [];
        while (i < lines.length && !lines[i].match(/^## /)) {
          body.push(lines[i]);
          i++;
        }
        // Trim trailing blank lines
        while (body.length > 0 && body[body.length - 1].trim() === '') {
          body.pop();
        }
        sections[name] = body.join('\n');
        continue;
      }
    }
    i++;
  }

  return sections;
}

// --- Get today's date in ET as YYYY-MM-DD ---
function todayET() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

// --- Assemble new kanban.md ---
function assembleKanban(sections, tagGroups) {
  const today = todayET();

  const parts = [];
  parts.push('# Kanban');
  parts.push(`Last updated: ${today} ET`);
  parts.push('');

  if (sections['Current goal']) {
    parts.push('## Current goal');
    parts.push(sections['Current goal']);
    parts.push('');
  }

  if (sections['Where we are']) {
    parts.push('## Where we are');
    parts.push(sections['Where we are']);
    parts.push('');
  }

  if (tagGroups.length === 0) {
    parts.push('## Queue — robotdojo');
    parts.push('');
    parts.push('_No active stories._');
    parts.push('');
  } else {
    for (const { tag, markdown } of tagGroups) {
      parts.push(`## Queue — ${tag}`);
      parts.push('');
      parts.push(markdown);
    }
  }

  if (sections['Cancelled']) {
    parts.push('## Cancelled');
    parts.push(sections['Cancelled']);
    parts.push('');
  }

  if (sections['Open questions']) {
    parts.push('## Open questions');
    parts.push(sections['Open questions']);
    parts.push('');
  }

  if (sections['Strategic context']) {
    parts.push('## Strategic context');
    parts.push(sections['Strategic context']);
    parts.push('');
  }

  if (sections['Product']) {
    parts.push('## Product');
    parts.push(sections['Product']);
    parts.push('');
  }

  if (sections["What doesn't change"]) {
    parts.push("## What doesn't change");
    parts.push(sections["What doesn't change"]);
    parts.push('');
  }

  return parts.join('\n');
}

// --- Main ---
function main() {
  const stories = loadStories();
  const tagGroups = buildClusters(stories);
  const renderedTagGroups = renderTagGroups(tagGroups);

  let existing = '';
  try {
    existing = readFileSync(KANBAN_FILE, 'utf8');
  } catch (_) {
    // File doesn't exist yet
  }

  const sections = existing ? parseKanban(existing) : {};
  const newContent = assembleKanban(sections, renderedTagGroups);

  // Atomic write: write to temp file, then rename
  const tmpFile = `${KANBAN_FILE}.tmp.${process.pid}`;
  writeFileSync(tmpFile, newContent, 'utf8');
  renameSync(tmpFile, KANBAN_FILE);

  const activeCount = stories.filter(s => !EXCLUDE_KANBAN.has(s.kanban)).length;
  const clusterCount = tagGroups.reduce((n, g) => n + g.clusters.length, 0);
  process.stdout.write(`kanban.md regenerated (${clusterCount} cluster(s), ${activeCount} active stories)\n`);
}

main();
