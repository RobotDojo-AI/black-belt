#!/usr/bin/env node
/**
 * kanban-eta.js
 * Computes an ETA for the remaining story backlog based on trailing throughput
 * or T-shirt size sum fallback.
 *
 * Usage: node ~/robotdojo/scripts/kanban-eta.js
 *
 * Env:
 *   ROBOTDOJO_STORIES_DIR — override stories directory (for testing)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { PIPELINE_STORIES_DIR } from '../lib/robotdojo-paths.js';

// --- Config ---
const STORIES_DIR = PIPELINE_STORIES_DIR;

const EXCLUDE_KANBAN = new Set(['done', 'cancelled', 'archived']);

// T-shirt size → days
const SIZE_DAYS = { XS: 0.5, S: 1, M: 2, L: 3, XL: 5 };

// --- Load stories ---
function loadStories() {
  let entries;
  try {
    entries = readdirSync(STORIES_DIR);
  } catch (err) {
    process.stderr.write(`Error: no stories found in ${STORIES_DIR}\n`);
    process.exit(1);
  }

  const stEntries = entries.filter(e => /^(st|df|wk)_/.test(e));
  if (stEntries.length === 0) {
    process.stderr.write(`Error: no stories found in ${STORIES_DIR}\n`);
    process.exit(1);
  }

  const stories = [];
  for (const entry of stEntries) {
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

// --- Get ISO week key YYYY-Www ---
function weekKey(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  // Thursday of the current week (ISO week definition)
  const thursday = new Date(d);
  thursday.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const year = thursday.getFullYear();
  const week1 = new Date(year, 0, 4); // first Thursday of year
  const weekNum =
    1 +
    Math.round(
      ((thursday.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7
    );
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

// --- p85 of an array ---
function p85(arr) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.ceil(0.85 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// --- Main ---
function main() {
  const stories = loadStories();

  const remaining = stories.filter(s => !EXCLUDE_KANBAN.has(s.kanban)).length;

  // Find completed stories with both started and a completion timestamp
  const missingTs = stories.filter(s => s.kanban === 'done' && !s.closed_at && !s.completed);
  if (missingTs.length > 0) {
    process.stderr.write(`Warning: ${missingTs.length} done stories missing closed_at and completed — skipped from velocity: ${missingTs.map(s => s.story_id).join(', ')}\n`);
  }

  const completed = stories.filter(
    s => s.kanban === 'done' && s.started && (s.closed_at || s.completed)
  );

  if (completed.length >= 5) {
    // Group by completion week
    const byWeek = new Map();
    for (const s of completed) {
      const key = weekKey(s.closed_at || s.completed);
      if (!key) continue;
      byWeek.set(key, (byWeek.get(key) || 0) + 1);
    }

    // Sort weeks descending, take up to 8 most recent
    const sortedWeeks = Array.from(byWeek.keys()).sort().reverse().slice(0, 8);
    const weeklyCounts = sortedWeeks.map(w => byWeek.get(w));

    const velocity = p85(weeklyCounts); // stories/week
    const days = velocity > 0 ? Math.ceil((remaining / velocity) * 7) : null;

    if (days != null) {
      process.stdout.write(
        `${remaining} stories remaining — ETA: ~${days} days at current velocity (${velocity.toFixed(1)} stories/week)\n`
      );
    } else {
      process.stdout.write(
        `${remaining} stories remaining — ETA: unknown (zero velocity in trailing 8 weeks)\n`
      );
    }
  } else {
    // Fallback: T-shirt size sum
    const openStories = stories.filter(s => !EXCLUDE_KANBAN.has(s.kanban));
    const sizedStories = openStories.filter(s => s.size && SIZE_DAYS[s.size] != null);
    const totalDays = sizedStories.reduce((sum, s) => sum + SIZE_DAYS[s.size], 0);

    if (sizedStories.length > 0) {
      process.stdout.write(
        `${remaining} stories remaining — ETA: ~${Math.ceil(totalDays)} days (size-based estimate, velocity data insufficient)\n`
      );
    } else {
      process.stdout.write(
        `${remaining} stories remaining — ETA: unknown (velocity data insufficient, no stories sized)\n`
      );
    }
  }
}

main();
