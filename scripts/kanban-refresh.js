#!/usr/bin/env node
export const INTELLIGENCE_TIER = 'extraction';

/**
 * kanban-refresh.js — st_fdd414de AC4.
 *
 * SUBTRACTION-design kanban refresher wired into /close. Unlike the destructive
 * kanban-regen.js (which rebuilds the whole file from a 7-name preserve-list and
 * DROPS every section not on it — Current State, Future Plan, Recent History,
 * the MEGA-STORY ARC block), this passes EVERY section through byte-for-byte and
 * mutates only three things:
 *
 *   1. The `Last updated:` stamp line (line after `# Kanban`) → today (ET).
 *   2. Each `## Queue — {domain}` section body → regenerated from meta.json
 *      (Active / Next / Backlog lanes). Hand-authored lanes that meta cannot
 *      reconstruct (e.g. `**Archived` / `**Archived / absorbed`) are preserved
 *      verbatim AFTER the regenerated lanes.
 *   3. `## Recent History` → ONE new line prepended to its body for the
 *      just-closed story (`--story <id>`). Every existing line is untouched.
 *
 * kanban.md is gitignored (pipeline user substrate) → this is a LOCAL refresh
 * only; close does NOT git-add it. Atomic write (temp + rename).
 *
 * Lane logic (deterministic from meta.json):
 *   - Active : kanban === 'in-progress'
 *   - Next   : non-terminal, unblocked (every depends_on is terminal/missing),
 *              with a numeric lane_position, sorted by lane_position
 *   - Backlog: every other non-terminal record
 *   Terminal records (done/archived/cancelled/closed/...) are omitted from the
 *   regenerated lanes.
 *
 * Env overrides (used by the fixture test so the LIVE kanban is never touched):
 *   ROBOTDOJO_KANBAN_PATH  — kanban file to refresh
 *   ROBOTDOJO_STORIES_DIR  — stories directory to read meta.json from
 * Both resolved through lib/robotdojo-paths.js.
 *
 * Usage:
 *   node scripts/kanban-refresh.js --story st_xxxxxxxx
 *   node scripts/kanban-refresh.js              # refresh Queues + stamp only
 */

import { readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { PIPELINE_STORIES_DIR, PIPELINE_KANBAN_PATH } from '../lib/robotdojo-paths.js';

const STORIES_DIR = PIPELINE_STORIES_DIR;
const KANBAN_FILE = PIPELINE_KANBAN_PATH;

// Kanban states that terminate a record (mirrors active-story.js TERMINAL_KANBAN).
const TERMINAL_KANBAN = new Set(['done', 'archived', 'cancelled', 'closed', 'closed-superseded', 'absorbed']);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--story') args.story = argv[++i];
  }
  return args;
}

// ── Load story meta ──────────────────────────────────────────────────────────
function loadStories() {
  let entries;
  try {
    entries = readdirSync(STORIES_DIR);
  } catch {
    return [];
  }
  const stories = [];
  for (const entry of entries) {
    if (!/^(st|df|wk)_/.test(entry)) continue;
    try {
      stories.push(JSON.parse(readFileSync(join(STORIES_DIR, entry, 'meta.json'), 'utf8')));
    } catch {
      // skip malformed
    }
  }
  return stories;
}

function isUnblocked(record, byId) {
  const deps = Array.isArray(record.depends_on) ? record.depends_on : [];
  if (deps.length === 0) return true;
  for (const id of deps) {
    const ref = byId.get(id);
    if (!ref) continue; // missing → presumed terminal
    if (!TERMINAL_KANBAN.has(ref.kanban)) return false;
  }
  return true;
}

// ── Render the regenerated lanes (Active / Next / Backlog) for one domain ─────
function renderQueueLanes(domain, stories, byId) {
  const inDomain = stories.filter((s) => (s.domain || 'robotdojo') === domain);
  const nonTerminal = inDomain.filter((s) => !TERMINAL_KANBAN.has(s.kanban));

  const active = nonTerminal
    .filter((s) => s.kanban === 'in-progress')
    .sort((a, b) => (a.lane_position ?? 0) - (b.lane_position ?? 0));

  const rest = nonTerminal.filter((s) => s.kanban !== 'in-progress');
  const next = rest
    .filter((s) => typeof s.lane_position === 'number' && isUnblocked(s, byId))
    .sort((a, b) => a.lane_position - b.lane_position);
  const nextIds = new Set(next.map((s) => s.story_id));
  const backlog = rest
    .filter((s) => !nextIds.has(s.story_id))
    .sort((a, b) => (a.story_id || '').localeCompare(b.story_id || ''));

  function laneLines(label, set) {
    const lines = [`**${label}**`, ''];
    if (set.length === 0) {
      lines.push('— None.');
    } else {
      for (const s of set) {
        const slug = s.slug || s.story_name || '';
        lines.push(`— \`${s.story_id}\` ${slug}`.trimEnd());
      }
    }
    lines.push('');
    return lines;
  }

  return [
    ...laneLines('Active', active),
    ...laneLines('Next', next),
    ...laneLines('Backlog', backlog),
  ];
}

// ── Today's date in ET (YYYY-MM-DD) ──────────────────────────────────────────
function todayET() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

// ── Split the file into the header (before first `## `) + ordered sections ────
// Each section is { heading: '## ...', body: [lines...] }. The header block
// (everything before the first `## `, including `# Kanban` + the `Last updated:`
// line) is returned separately so we can stamp it.
function splitSections(content) {
  const lines = content.split('\n');
  const header = [];
  const sections = [];
  let cur = null;
  for (const line of lines) {
    if (/^## /.test(line)) {
      if (cur) sections.push(cur);
      cur = { heading: line, body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      header.push(line);
    }
  }
  if (cur) sections.push(cur);
  return { header, sections };
}

// Refresh the `Last updated:` line in the header block.
function stampHeader(header) {
  const today = todayET();
  return header.map((line) =>
    /^Last updated:/.test(line) ? `Last updated: ${today} ET` : line,
  );
}

// Regenerate a `## Queue — {domain}` body: replace the Active/Next/Backlog
// lanes with the deterministic render, PRESERVE any trailing hand-authored lane
// (the first `**` lane whose label is not Active/Next/Backlog, e.g.
// `**Archived / absorbed by cleanup**`) verbatim. The section's leading/trailing
// blank-line shape is reproduced from the render so output is byte-stable.
function refreshQueueBody(heading, domain, stories, byId) {
  const oldBody = heading.startsWith('## Queue — '); // sanity (caller-checked)
  void oldBody;
  return renderQueueLanes(domain, stories, byId);
}

function domainFromHeading(heading) {
  const m = heading.match(/^## Queue — (.+)$/);
  return m ? m[1].trim() : null;
}

// Extract hand-authored trailing lanes from a Queue body: everything from the
// first `**` lane whose label is NOT one of the regenerated lanes onward.
function trailingHandLanes(body) {
  const REGEN = new Set(['Active', 'Next', 'Backlog']);
  for (let i = 0; i < body.length; i++) {
    const m = body[i].match(/^\*\*(.+?)\*\*\s*$/);
    if (m && !REGEN.has(m[1].trim())) {
      // Found a hand-authored lane — keep from here to the end (trim trailing
      // blank run, then re-add one trailing blank for spacing).
      const tail = body.slice(i);
      while (tail.length > 0 && tail[tail.length - 1].trim() === '') tail.pop();
      tail.push('');
      return tail;
    }
  }
  return [];
}

function refreshRecentHistory(body, closed) {
  if (!closed) return body;
  // Prepend ONE line at the top of the Recent History body. The body starts
  // with a blank line (between heading and first entry); insert the new line
  // after that leading blank so it reads as the newest entry.
  const stamp = (closed.closed_at || '').slice(0, 10) || todayET();
  const verdict = closed.verdict || 'PASS';
  const name = closed.story_name || closed.slug || closed.story_id;
  const entry = `**${stamp} — ${closed.story_id} ${name} closed (${verdict}).**`;
  // Find first non-blank position; insert before it, preserving the leading blank.
  let i = 0;
  while (i < body.length && body[i].trim() === '') i++;
  return [...body.slice(0, i), entry, '', ...body.slice(i)];
}

function main() {
  const args = parseArgs(process.argv);

  let content;
  try {
    content = readFileSync(KANBAN_FILE, 'utf8');
  } catch {
    process.stderr.write(`kanban-refresh: cannot read ${KANBAN_FILE}\n`);
    process.exit(1);
  }

  const stories = loadStories();
  const byId = new Map(stories.map((s) => [s.story_id, s]));
  const closed = args.story ? byId.get(args.story) : null;

  const { header, sections } = splitSections(content);
  const newHeader = stampHeader(header);

  const newSections = sections.map((sec) => {
    const domain = domainFromHeading(sec.heading);
    if (domain) {
      const lanes = refreshQueueBody(sec.heading, domain, stories, byId);
      const hand = trailingHandLanes(sec.body);
      // Section body shape: leading blank, lanes, then any hand-authored lanes.
      return { heading: sec.heading, body: ['', ...lanes, ...hand] };
    }
    if (/^## Recent History\s*$/.test(sec.heading)) {
      return { heading: sec.heading, body: refreshRecentHistory(sec.body, closed) };
    }
    // Every other section: byte-for-byte pass-through.
    return sec;
  });

  // Reassemble. Sections were split on `## ` boundaries; each section's body is
  // the lines that followed its heading (the trailing blank before the next
  // heading is part of the body), so joining heading + body with newlines and
  // concatenating reproduces the original byte layout for untouched sections.
  const parts = [newHeader.join('\n')];
  for (const sec of newSections) {
    parts.push(sec.heading + '\n' + sec.body.join('\n'));
  }
  const out = parts.join('\n');

  const tmp = `${KANBAN_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, out, 'utf8');
  renameSync(tmp, KANBAN_FILE);

  process.stdout.write(
    `kanban-refresh: stamped, Queue lanes regenerated${closed ? `, Recent History entry added for ${closed.story_id}` : ''}\n`,
  );
}

main();
