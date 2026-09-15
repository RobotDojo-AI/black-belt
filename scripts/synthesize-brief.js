#!/usr/bin/env node
/**
 * World-brief synthesis — the chief-of-staff cheat sheet injected as cached
 * chat block 4 (st_2cd1af73 UNIFIED CONTEXT WATERFALL).
 *
 * Replaces the old hand-authored grounding tail (deleted) and the never-built
 * topic-landscape idea with ONE canonical markdown the chat path reads from
 * disk: user/contexts/brief.md. The file is synthesized DAILY (maint_brief
 * phase + this manual seed run), never per chat turn — chat reads the file's
 * `## Summary` tier mtime-keyed, so it is stable within a day and rotates once
 * a night. No LLM ever runs on a chat request path.
 *
 * WHAT THE BRIEF COVERS (owner spec):
 *   a) last 48 hours across the user's data — chat conversations, emails,
 *      calendar events, notable activity — key themes, learnings, focus areas;
 *   b) next 48 hours — upcoming calendar with context;
 *   c) core-tier people roster one-liner block;
 *   d) compressed topic index — label + 5-8 word gist from each topic's Summary.
 *
 * SOURCES (read-only): conversations + messages, calendar_events, user_topics,
 * people (n2 relationship tier). All Tier-0 deterministic gather; one Tier-2
 * Sonnet call synthesizes (a)+(b)+(c) prose. The topic index (d) is built
 * DETERMINISTICALLY (no LLM) so the chat fallback can reproduce it byte-for-byte
 * when the file is missing on a fresh install (pre-first-synthesis).
 *
 * ── Compute Tier Protocol (agents/build-conventions.md) ──────────────────────
 *   Tier 0 (free): SQL gather + structural compression of the last/next 48h,
 *                  core roster, and topic-summary gists. Always first.
 *   Tier 2 (Sonnet): ONE synthesis call over the pre-gathered, pre-compressed
 *                    structured digest → the `## Summary` prose. Nightly cadence,
 *                    never per turn, so Sonnet (not Haiku) is the right quality
 *                    tier — same call shape topic-context synthesis uses.
 *   Tier 1/3 not used: no bulk classification, no critical-decision finals.
 *
 * ── Intelligence Tier Protocol (agents/build-conventions.md) ─────────────────
 * This script READS structured DB state and the deterministic topic index, calls
 * Sonnet, and WRITES exactly ONE canonical markdown (user/contexts/brief.md).
 * It writes NO DB row/edge via the LLM — the LLM write boundary holds.
 */
export const INTELLIGENCE_TIER = 'synthesis';

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { modelFor } from '../lib/model-lane.js';

import db from '../lib/db.js';
import { llmCreate } from '../lib/llm-gateway.js';
import { USER_CONTEXTS_DIR } from '../lib/robotdojo-paths.js';
import {
  BRIEF_PATH,
  BRIEF_SUMMARY_BUDGET,
  BRIEF_MICRO_BUDGET,
  buildDeterministicTopicIndex,
  buildDeterministicCoreRoster,
} from '../lib/chat/brief.js';

// Longer gist for the deterministic-fallback brief (matches the reader's
// absent-file fallback) so a synthesis-failed brief still fills block 4 toward
// its budget and clears the cache floor. Env-overridable, same key the reader uses.
const FALLBACK_GIST_CHARS = Number(process.env.ROBOTDOJO_BRIEF_TOPIC_GIST_CHARS_FALLBACK || 180);

// ── Tunables (env-overridable per build conventions) ─────────────────────────
// Window each direction. 48h is the owner spec; both directions use the same
// window so "what just happened / what's next" is symmetric.
const WINDOW_HOURS = Number(process.env.ROBOTDOJO_BRIEF_WINDOW_HOURS || 48);
// Caps on the structured digest fed to Sonnet — keep the prompt bounded so the
// synthesis stays a small, fast call (the digest is pre-compressed Tier-0
// output, not a raw dump).
// Digest caps. Sized so the synthesis INPUT stays compact (a tight, pre-filtered
// digest, not a raw dump) — a 4k-char brief does not need 40 conversations or 56
// events to find the themes, and a smaller input keeps the Sonnet call's
// time-to-first-token low (load-bearing when the API is degraded/spiky).
const MAX_CONVERSATIONS = Number(process.env.ROBOTDOJO_BRIEF_MAX_CONVERSATIONS || 24);
const MAX_CONV_CHARS = Number(process.env.ROBOTDOJO_BRIEF_MAX_CONV_CHARS || 200);
const MAX_PAST_EVENTS = Number(process.env.ROBOTDOJO_BRIEF_MAX_PAST_EVENTS || 20);
const MAX_FUTURE_EVENTS = Number(process.env.ROBOTDOJO_BRIEF_MAX_FUTURE_EVENTS || 24);
const MAX_ROSTER = Number(process.env.ROBOTDOJO_BRIEF_MAX_ROSTER || 16);

const DRY_RUN = process.argv.includes('--dry-run');

// ─────────────────────────────────────────────────────────────────────────────
// Tier 0 — deterministic gather. Each helper returns a compact text digest the
// synthesis prompt stitches together. Every query is try/guarded: a missing
// table (fresh install) degrades that section to '' rather than throwing, so
// the brief still synthesizes from whatever data exists (graceful degradation).
// ─────────────────────────────────────────────────────────────────────────────

const isoNow = () => new Date().toISOString();
const isoHoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

/**
 * Recent conversation activity (last WINDOW_HOURS). The owner's chats are
 * mostly topic-untagged (topic_slug NULL on ~all of them), so we summarize by
 * conversation title + a short sample of the latest user message, NOT by topic
 * tag — the synthesis reads the THEMES off these, it does not need tags.
 * Returns a digest line per active conversation, newest first.
 */
function gatherRecentChats(sinceIso) {
  try {
    const rows = db.prepare(`
      SELECT c.id, c.title, c.topic_slug, MAX(m.created_at) AS last_at, COUNT(m.id) AS msgs
      FROM conversations c
      JOIN messages m ON m.conversation_id = c.id
      WHERE m.created_at >= ? AND COALESCE(c.archived,0)=0 AND c.deleted_at IS NULL
      GROUP BY c.id
      ORDER BY last_at DESC
      LIMIT ?
    `).all(sinceIso, MAX_CONVERSATIONS);
    if (!rows.length) return '';
    const lines = [];
    const sampleStmt = db.prepare(
      "SELECT content FROM messages WHERE conversation_id = ? AND role='user' ORDER BY seq DESC LIMIT 1",
    );
    for (const r of rows) {
      const title = (r.title && r.title !== 'New chat') ? r.title : '';
      let sample = '';
      try { sample = (sampleStmt.get(r.id)?.content || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CONV_CHARS); } catch { /* guarded */ }
      const day = String(r.last_at || '').slice(0, 10);
      const head = title || sample.slice(0, 60) || '(untitled)';
      const tail = title && sample ? ` — "${sample}"` : '';
      lines.push(`- (${day}, ${r.msgs} msg) ${head}${tail}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/** Calendar events in [sinceIso, nowIso] — what just happened. */
function gatherPastEvents(sinceIso, nowIso) {
  return gatherEvents(sinceIso, nowIso, MAX_PAST_EVENTS, 'DESC');
}

/** Calendar events in [nowIso, untilIso] — what's next. */
function gatherFutureEvents(nowIso, untilIso) {
  return gatherEvents(nowIso, untilIso, MAX_FUTURE_EVENTS, 'ASC');
}

function gatherEvents(fromIso, toIso, limit, order) {
  try {
    const rows = db.prepare(`
      SELECT summary, start_time, location, attendees, all_day
      FROM calendar_events
      WHERE start_time >= ? AND start_time <= ?
        AND status != 'cancelled'
      ORDER BY start_time ${order === 'DESC' ? 'DESC' : 'ASC'}
      LIMIT ?
    `).all(fromIso, toIso, limit);
    if (!rows.length) return '';
    const lines = rows.map((r) => {
      const when = String(r.start_time || '').slice(0, 16).replace('T', ' ');
      const summ = (r.summary || '(busy)').replace(/\s+/g, ' ').trim().slice(0, 90);
      const loc = r.location ? ` @ ${String(r.location).replace(/\s+/g, ' ').trim().slice(0, 40)}` : '';
      // Attendee count (not names — the synthesis names people from the roster,
      // and raw attendee emails would only add noise + PII surface to the digest).
      let people = '';
      try {
        const att = JSON.parse(r.attendees || '[]');
        if (Array.isArray(att) && att.length > 1) people = ` (${att.length} attendees)`;
      } catch { /* attendees not JSON — skip */ }
      return `- ${when} ${summ}${loc}${people}`;
    });
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * Core-tier people roster — one line each. Uses n2 (the relationship tier:
 * Family/Partners/Core) which is the curated importance label, ranked by score.
 * Each line: name — relation, recent-contact signal. This is the same roster the
 * synthesis turns into a tight "who's in your inner circle" block.
 */
function gatherCoreRoster() {
  try {
    const rows = db.prepare(`
      SELECT display_name, short_name, n2, last_seen, interaction_count,
             (SELECT name FROM companies WHERE id = people.company_id) AS company
      FROM people
      WHERE COALESCE(archived,0)=0
        AND n2 IN ('Family','Partners','Core')
      ORDER BY
        CASE n2 WHEN 'Family' THEN 0 WHEN 'Partners' THEN 1 ELSE 2 END,
        score DESC
      LIMIT ?
    `).all(MAX_ROSTER);
    if (!rows.length) return '';
    const lines = rows.map((r) => {
      const name = r.short_name || r.display_name;
      const rel = r.n2 || '';
      const co = r.company ? `, ${r.company}` : '';
      const last = r.last_seen ? `, last ${String(r.last_seen).slice(0, 10)}` : '';
      return `- ${name} (${rel}${co}${last})`;
    });
    return lines.join('\n');
  } catch {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 — synthesis. ONE Sonnet call over the pre-gathered digest. The prompt
// asks for the chief-of-staff cheat sheet at the Summary budget; the topic index
// is appended deterministically afterward (no LLM), so the model never has to
// reproduce it and can spend its whole budget on the 48h + roster prose.
// ─────────────────────────────────────────────────────────────────────────────

function buildSynthesisPrompt({ recentChats, pastEvents, futureEvents, roster, nowIso }) {
  const today = nowIso.slice(0, 10);
  const sections = [];
  if (recentChats) sections.push(`RECENT CHAT ACTIVITY (last ${WINDOW_HOURS}h, newest first — conversation titles + a sampled message each):\n${recentChats}`);
  if (pastEvents) sections.push(`CALENDAR — LAST ${WINDOW_HOURS}h (what just happened):\n${pastEvents}`);
  if (futureEvents) sections.push(`CALENDAR — NEXT ${WINDOW_HOURS}h (what's coming):\n${futureEvents}`);
  if (roster) sections.push(`CORE PEOPLE (inner-circle relationship tiers, ranked):\n${roster}`);
  const digest = sections.join('\n\n') || '(No recent activity, calendar, or roster data was available.)';

  return `You are writing a daily chief-of-staff cheat sheet for a personal AI assistant. The assistant reads this at the top of every conversation to know what the user has been doing, what's coming up, and who matters — so it can answer with that grounding without the user re-explaining their week.

Today is ${today}. Below is the user's own structured data, already filtered to the relevant window. Write the brief FROM this data — do not invent events, people, or themes that aren't here.

${digest}

Write a tight briefing with exactly these three sections, in this order:

## Last 48 hours
The themes, threads, and focus areas from the recent chat activity and the calendar events that just happened. Name what the user has been working through and any learnings or decisions visible in the activity. Group by theme, not by source. 2-5 short paragraphs or a tight bullet list.

## Next 48 hours
The upcoming calendar with the context that makes each item actionable — who it's with (use the core-people list to add names/relationships where an event clearly maps), what it's likely about, anything the user should walk in prepared for. Skip routine filler. If the calendar is empty, say so in one line.

## Inner circle
A one-line-per-person roster of the core people above: name — relationship, and the freshest contact signal. Keep it scannable.

Rules:
- Write in second person ("You met with…", "Your week was…").
- Every sentence must be useful — no filler, no hedging, no padding to hit a length.
- Total under ${BRIEF_SUMMARY_BUDGET} characters. Stop when the briefing is complete; leave it short rather than padding with noise.
- Do not describe the data sources or that this is generated. Just the briefing.`;
}

// Bounded retry — the brief is a daily batch, not on a request path, so a few retries
// with backoff are cheap and let it ride out a degraded/spiky API (the exact
// condition on the day this was built). Returns '' only after all attempts fail,
// at which point the brief degrades to the deterministic topic index.
const SYNTH_ATTEMPTS = Number(process.env.ROBOTDOJO_BRIEF_SYNTH_ATTEMPTS || 4);
const SYNTH_BACKOFF_MS = Number(process.env.ROBOTDOJO_BRIEF_SYNTH_BACKOFF_MS || 4000);

async function synthesizeSummary(digest) {
  const prompt = buildSynthesisPrompt(digest);
  for (let attempt = 1; attempt <= SYNTH_ATTEMPTS; attempt++) {
    try {
      const response = await llmCreate({
        model: modelFor('balanced'),
        // Right-sized: the Summary budget is ~4k chars ≈ 1000 tokens, so 1300 is
        // ample headroom. A tighter max_tokens means a shorter generation, which
        // both keeps the brief tight and shrinks the window where a degraded API
        // can time out mid-stream.
        max_tokens: 1300,
        messages: [{ role: 'user', content: prompt }],
      }, 'brief');
      const text = response.content?.[0]?.text || '';
      const trimmed = String(text).trim();
      if (trimmed) return trimmed;
      console.warn(`[brief] synthesis attempt ${attempt} returned empty text`);
    } catch (e) {
      console.warn(`[brief] synthesis attempt ${attempt}/${SYNTH_ATTEMPTS} failed: ${e.message}`);
    }
    if (attempt < SYNTH_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, SYNTH_BACKOFF_MS * attempt));
    }
  }
  console.warn('[brief] all synthesis attempts failed — falling back to deterministic topic index');
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Assemble + write the canonical markdown.
//   ## Summary  — the synthesized prose, capped at the Summary budget. This is
//                 the tier chat injects as cached block 4 (mtime-keyed).
//   ## Micro    — an optional ~1k ultra-compressed tier (the topic index alone),
//                 reserved for a future tighter-budget injection path. Built from
//                 the SAME deterministic topic index so it is always coherent.
//   ## History  — nothing here yet; reserved so the Summary/History split parser
//                 (lib/chat-context.js extractSummarySection) stops cleanly at
//                 the end of Summary regardless of what trails it.
// The deterministic topic index is appended INSIDE the Summary section (under a
// `### Topic index` subhead) so a single cached-block read carries roster + 48h
// prose + the topic map. Chat reads the whole `## Summary` body.
// ─────────────────────────────────────────────────────────────────────────────

function assembleMarkdown({ summaryProse, topicIndex, fallbackRoster, fallbackIndex, nowIso }) {
  // st_db4b3118 — record which mode produced this edition so the maintenance
  // BRIEF FRESHNESS tick (scripts/supervisor-maintenance-worker.mjs) can tell a
  // real prose edition from a deterministic fallback and keep attempting a prose
  // synthesis (only) when the API recovers. `synthesized` = the Sonnet prose
  // landed; `deterministic-fallback` = synthesis failed and we wrote the rich
  // deterministic brief as an interim.
  const briefMode = summaryProse ? 'synthesized' : 'deterministic-fallback';
  let summaryBody;
  if (summaryProse) {
    // The synthesized prose already carries its own ## sections (Last 48 hours /
    // Next 48 hours / Inner circle). We wrap them under a top-level `## Summary`
    // so the chat injector's `## Summary` … (next `##` / `---`) parser captures the
    // whole brief. To keep the inner headings from prematurely terminating the
    // Summary parse, demote the model's `## ` headings to `### `.
    const demoted = String(summaryProse).replace(/^##\s+/gm, '### ');
    summaryBody = [
      demoted.trim(),
      topicIndex ? `### Topic index\n${topicIndex}` : '',
    ].filter(Boolean).join('\n\n').slice(0, BRIEF_SUMMARY_BUDGET);
  } else {
    // Synthesis failed → write the SAME rich deterministic brief the chat reader
    // builds on an absent file (inner-circle roster + long-gist topic index), so
    // the file-present read still fills block 4 toward its budget and the
    // universal cache entry clears the floor without the daily synthesis.
    const parts = [];
    if (fallbackRoster && fallbackRoster.trim()) parts.push(`### Inner circle\n${fallbackRoster}`);
    if (fallbackIndex && fallbackIndex.trim()) parts.push(`### Active areas\n${fallbackIndex}`);
    summaryBody = parts.join('\n\n').slice(0, BRIEF_SUMMARY_BUDGET);
  }

  // Micro tier — the topic index alone, hard-capped. A standing ultra-compact
  // option; built deterministically so it never costs an LLM call.
  const microBody = topicIndex
    ? topicIndex.slice(0, BRIEF_MICRO_BUDGET)
    : '';

  const parts = [
    `<!-- GENERATED by scripts/synthesize-brief.js — daily. Do not hand-edit; edits are overwritten on the next synthesis. -->`,
    `<!-- synthesized_at: ${nowIso} -->`,
    `<!-- brief_mode: ${briefMode} -->`,
    '',
    '## Summary',
    '',
    summaryBody,
  ];
  if (microBody) {
    parts.push('', '---', '', '## Micro', '', microBody);
  }
  parts.push('');
  return parts.join('\n');
}

async function main() {
  const nowIso = isoNow();
  const sinceIso = isoHoursFromNow(-WINDOW_HOURS);
  const untilIso = isoHoursFromNow(WINDOW_HOURS);

  // Tier 0 gather (deterministic).
  const recentChats = gatherRecentChats(sinceIso);
  const pastEvents = gatherPastEvents(sinceIso, nowIso);
  const futureEvents = gatherFutureEvents(nowIso, untilIso);
  const roster = gatherCoreRoster();
  const topicIndex = buildDeterministicTopicIndex(db);

  const digest = { recentChats, pastEvents, futureEvents, roster, nowIso };
  const counts = {
    chats: (recentChats.match(/\n/g) || []).length + (recentChats ? 1 : 0),
    past: (pastEvents.match(/\n/g) || []).length + (pastEvents ? 1 : 0),
    future: (futureEvents.match(/\n/g) || []).length + (futureEvents ? 1 : 0),
    roster: (roster.match(/\n/g) || []).length + (roster ? 1 : 0),
    topics: (topicIndex.match(/\n/g) || []).length + (topicIndex ? 1 : 0),
  };
  console.info(`[brief] gathered: chats=${counts.chats} past_events=${counts.past} future_events=${counts.future} roster=${counts.roster} topic_index_lines=${counts.topics}`);

  // Tier 2 synthesis.
  const summaryProse = await synthesizeSummary(digest);
  // Deterministic fallback content (used only when synthesis is empty) — the
  // SAME rich brief the chat reader builds on an absent file, so a synthesis
  // failure still produces a floor-clearing block 4.
  const fallbackRoster = buildDeterministicCoreRoster(db);
  const fallbackIndex = buildDeterministicTopicIndex(db, FALLBACK_GIST_CHARS);
  if (!summaryProse) {
    console.warn('[brief] synthesis returned empty — writing rich deterministic fallback brief (roster + topic index).');
  }

  const markdown = assembleMarkdown({ summaryProse, topicIndex, fallbackRoster, fallbackIndex, nowIso });

  if (DRY_RUN) {
    console.info('[brief] --dry-run: not writing. Preview below:\n');
    console.info(markdown.slice(0, 2000));
    return { ok: true, bytes: markdown.length, path: BRIEF_PATH, dryRun: true };
  }

  mkdirSync(dirname(BRIEF_PATH), { recursive: true });
  // Defensive: ensure the contexts dir exists even when BRIEF_PATH is a
  // symlink target chain (user/contexts → ~/.robotdojo/contexts).
  try { mkdirSync(USER_CONTEXTS_DIR, { recursive: true }); } catch { /* best-effort */ }
  writeFileSync(BRIEF_PATH, markdown, 'utf8');
  console.info(`[brief] wrote ${markdown.length} bytes → ${BRIEF_PATH}`);
  return { ok: true, bytes: markdown.length, path: BRIEF_PATH };
}

// Allow import for the BRIEF maintenance phase (runBriefSynthesis) without auto-running.
export async function runBriefSynthesis() {
  return main();
}

// CLI entry — only when invoked directly (node scripts/synthesize-brief.js).
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main()
    .then((r) => { console.info('[brief] done:', JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error('[brief] fatal:', e.message); process.exit(1); });
}
