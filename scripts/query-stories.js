#!/usr/bin/env node
/**
 * query-stories.js
 * Reads all PIPELINE_STORIES_DIR/{story_id}/meta.json files and filters/sorts them.
 *
 * Flags:
 *   --status <value>   Filter by kanban status (e.g. in-progress, done, backlog)
 *   --epic <value>     Filter by epic field
 *   --day <value>      Filter by launch_day field
 *   --reindex          Regenerate PIPELINE_INDEX_PATH (sorted by started desc)
 *
 * Output: JSON array to stdout (filtered/sorted), or --reindex writes the file.
 * Exits non-zero on unknown flags.
 *
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PIPELINE_STORIES_DIR, PIPELINE_INDEX_PATH } from '../lib/robotdojo-paths.js';

const HOME = process.env.HOME;
const STORIES_BASE = PIPELINE_STORIES_DIR;
const INDEX_PATH = PIPELINE_INDEX_PATH;

// Parse flags
const args = process.argv.slice(2);
const flags = {};
const unknownFlags = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--status') {
    flags.status = args[++i];
  } else if (args[i] === '--epic') {
    flags.epic = args[++i];
  } else if (args[i] === '--day') {
    flags.day = args[++i];
  } else if (args[i] === '--reindex') {
    flags.reindex = true;
  } else if (args[i] === '--started-after') {
    flags.startedAfter = args[++i];
  } else if (args[i] === '--closed-after') {
    flags.closedAfter = args[++i];
  } else if (args[i] === '--updated-after') {
    flags.updatedAfter = args[++i];
  } else if (args[i] === '--tag') {
    flags.tag = args[++i];
  } else if (args[i] === '--domain') {
    flags.domain = args[++i];
  } else if (args[i] === '--group-by') {
    flags.groupBy = args[++i];
  } else if (args[i].startsWith('--')) {
    unknownFlags.push(args[i]);
  }
}

if (unknownFlags.length > 0) {
  process.stderr.write(`Error: unknown flag(s): ${unknownFlags.join(', ')}\n`);
  process.exit(1);
}

// Read all story directories
function readAllStories() {
  const stories = [];

  let dirs = [];
  try {
    dirs = readdirSync(STORIES_BASE).filter(d => /^(st|df|wk)_/.test(d));
  } catch (e) {
    process.stderr.write(`Warning: cannot read stories dir: ${e.message}\n`);
    return stories;
  }

  for (const dir of dirs) {
    const metaPath = join(STORIES_BASE, dir, 'meta.json');
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

      // Compute duration_hours from started → completed
      if (meta.started && meta.completed) {
        const startMs = new Date(meta.started).getTime();
        const endMs = new Date(meta.completed).getTime();
        if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
          meta.duration_hours = parseFloat(((endMs - startMs) / 3600000).toFixed(2));
        } else {
          meta.duration_hours = null;
        }
      } else {
        meta.duration_hours = null;
      }

      const storyDir = join(STORIES_BASE, dir);
      const hasResearch = existsSync(join(storyDir, '01-research.md'));
      meta._has_research = hasResearch;

      stories.push(meta);
    } catch (e) {
      // Skip malformed meta.json — do not throw
      process.stderr.write(`Warning: skipping ${dir}: ${e.message}\n`);
    }
  }

  // Sort by started date descending (most recent first)
  stories.sort((a, b) => {
    const aTime = a.started ? new Date(a.started).getTime() : 0;
    const bTime = b.started ? new Date(b.started).getTime() : 0;
    return bTime - aTime;
  });

  return stories;
}

// Apply filters
function applyFilters(stories, flags) {
  let result = stories;

  if (flags.status !== undefined) {
    result = result.filter(s => s.kanban === flags.status);
  }

  if (flags.epic !== undefined) {
    result = result.filter(s => String(s.epic) === String(flags.epic));
  }

  if (flags.day !== undefined) {
    result = result.filter(s => String(s.launch_day) === String(flags.day));
  }

  if (flags.startedAfter !== undefined) {
    result = result.filter(s => s.started && s.started >= flags.startedAfter);
  }

  if (flags.closedAfter !== undefined) {
    result = result.filter(s => s.closed_at && s.closed_at >= flags.closedAfter);
  }

  if (flags.updatedAfter !== undefined) {
    result = result.filter(s => s.updated_at && s.updated_at >= flags.updatedAfter);
  }

  if (flags.tag !== undefined) {
    result = result.filter(s => s.tags?.includes(flags.tag));
  }

  if (flags.domain !== undefined) {
    result = result.filter(s => s.domain === flags.domain);
  }

  return result;
}

// Main
const allStories = readAllStories();

if (flags.reindex) {
  // Write story-index.json — all stories, sorted by started desc
  writeFileSync(INDEX_PATH, JSON.stringify(allStories, null, 2));
  process.stdout.write(`Wrote ${allStories.length} stories to ${INDEX_PATH}\n`);
} else {
  const filtered = applyFilters(allStories, flags);
  if (flags.groupBy === 'domain') {
    // Grouped output: { <domain>: [story, …], … }.
    const grouped = {};
    for (const s of filtered) {
      const d = s.domain || 'unassigned';
      if (!grouped[d]) grouped[d] = [];
      grouped[d].push(s);
    }
    process.stdout.write(JSON.stringify(grouped, null, 2) + '\n');
  } else {
    process.stdout.write(JSON.stringify(filtered, null, 2) + '\n');
  }
}
