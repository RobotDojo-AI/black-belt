/**
 * lib/followup-sweep.js — Post-call synthesis sweep for /followup skill.
 *
 * Given a person's display name (and optionally the owner's post-call notes),
 * this module:
 *   1. Finds the most recent Granola transcript that person attended.
 *   2. Pulls the last 10 inbound emails from that person.
 *   3. Gets iMessage frequency for that person.
 *   4. Synthesises call notes via Haiku (Tier 1) — transcript + notes + comms.
 *   5. Extracts the people/companies the owner NAMED IN THEIR NOTES (curated;
 *      the transcript is never mined for entity names — ASR yields junk).
 *   6. For each note-entity that has a source URL, spawns the /profile skill to
 *      do live LinkedIn/Crunchbase research and write the context file. /profile
 *      prints a PROFILE_RESULT line naming the exact file; the sweep verifies it
 *      on disk before claiming it — no guessed or phantom paths.
 *   7. Looks up or creates the person's Asana People board card.
 *   8. Writes the formatted html_notes (summary + entity links) to the card.
 *   9. Extracts next steps from the transcript + notes and creates subtasks.
 *
 * WHY INTELLIGENCE_TIER = 'synthesis':
 *   This module reads structured data (DB rows, search results) and writes to
 *   canonical docs (entity context files) and Asana (the person's card). All LLM
 *   calls are Haiku (Tier 1) for bulk extraction — not Tier 3 critical decisions.
 *
 * Owner email filter: any attendee email matching config.ownerEmail is skipped
 * when resolving entities, so the owner is never created as a third-party entity.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve as resolvePath, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { modelFor } from './model-lane.js';

import { llmCreate } from './llm-gateway.js';
import { readKeychainSecret } from './keychain.js';
import { entityContextPath } from './context-paths.js';
import { resolveEntityFromUrl } from './profile-research.js';
import { REPO_ROOT } from './robotdojo-paths.js';
import config from './config.js';
import { loadFollowupContext, loadCompanyFollowupContext } from './followup-entities.js';
import { loadAsanaRoutingConfig, isConfiguredGid } from './asana-routing-config.js';

// ── Intelligence tier declaration (required by check-structure.js) ────────────
export const INTELLIGENCE_TIER = 'synthesis';

// ── Asana constants ────────────────────────────────────────────────────────────
// People/Companies board + Researching section gids all come from
// config/asana-routing.json (boards.people / boards.companies) — NO gid literals
// in lib/ (df_e1dcf732 AC9, one source of truth). The tracked config ships
// PLACEHOLDER gids; the owner's real board gids live only in the gitignored
// config/asana-routing.user.json override. On a fresh clone the gids are
// placeholders and the Asana writes are skipped (see isConfiguredGid guard in
// runFollowupSweep), so the sweep still runs its synthesis + context-file writes
// without crashing. Workspace gid comes from the same config (Asana requires one
// of workspace/parent/projects on task creation — memberships alone is HTTP 400).
const _asanaCfg = loadAsanaRoutingConfig();
const PEOPLE_BOARD_GID = _asanaCfg.boards?.people?.project ?? '';
const COMPANIES_BOARD_GID = _asanaCfg.boards?.companies?.project ?? '';
const RESEARCHING_SECTION_GID = _asanaCfg.boards?.people?.sections?.researching ?? '';
const WORKSPACE_GID = _asanaCfg.destinations.default.workspace;
const ASANA_BASE = 'https://app.asana.com/api/1.0';

// ── Entity URL builder ─────────────────────────────────────────────────────────

/**
 * Build a deep-link URL for a Robot Dojo entity using the canonical slug+shortId format.
 *
 * WHY slug+shortId: the frontend router at apps/network/app.js resolves URLs via
 * /api/content/{type}/{shortId} LIKE lookup. Raw entity IDs in the URL break on
 * refresh when the router regex doesn't recognise the ID format. The slug+shortId
 * format is stable and matches what history.replaceState writes on selectPerson.
 *
 * @param {'people'|'companies'} type  - plural form used in URL path segment
 * @param {string} id                  - entity primary key (people.id or companies.id)
 * @param {string} displayName         - display name for slug generation
 * @param {object} cfg                 - config object (expects cfg.deviceSlug)
 * @returns {string}
 */
export function buildEntityUrl(type, id, displayName, cfg) {
  const base = cfg?.deviceSlug
    ? `https://${cfg.deviceSlug}.robotdojo.ai`
    : `https://localhost:${config.ports.app}`;
  const slug = (displayName || '')
    .trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/, '').slice(0, 50);
  const shortId = String(id || '').replace(/-/g, '').slice(0, 8);
  const path = slug ? `${slug}-${shortId}` : shortId;
  return `${base}/network/${type}/${path}`;
}

// ── Asana html_notes builder ───────────────────────────────────────────────────

/**
 * Build an Asana-safe html_notes string.
 *
 * Confirmed safe subset (empirically tested 2026-06-13):
 *   body, strong, a[href], ul, li, nested ul>li, \n
 * Forbidden: p, br, br/, div, span, em, &nbsp;
 *
 * Format: date on its own line, content type on its own line, then summary,
 * entities, integrated comms context, next steps.
 *
 * @param {object} data
 * @param {string} data.date         - ISO date string (YYYY-MM-DD)
 * @param {string} data.source       - source label, e.g. "Granola call"
 * @param {string} data.summary      - one or two sentence call summary
 * @param {Array}  data.entities     - [{ name, url, bullets: string[] }]
 * @param {string} [data.commsContext] - integrated email+SMS summary sentence(s)
 * @param {Array}  data.nextSteps    - string[] of next-step actions
 * @returns {string}
 */
export function buildHtmlNotes({ date, source, summary, entities, commsContext, nextSteps }) {
  const displayDate = formatDate(date);
  const entityItems = (entities || []).map(e => {
    const link = e.url
      ? `<a href="${e.url}">${e.name}</a>`
      : e.name;
    const subBullets = (e.bullets || []).length > 0
      ? `\n<ul>${(e.bullets).map(b => `<li>${b}</li>`).join('\n')}</ul>\n`
      : '';
    return `<li>${link}${subBullets}</li>`;
  }).join('\n');

  const nextStepItems = (nextSteps || []).map(s => `<li>${s}</li>`).join('\n');

  const parts = [
    `<body>`,
    `<strong>${displayDate}</strong>`,
    `<strong>${source}</strong>`,
    summary,
  ];
  if (entityItems) {
    parts.push(`<ul>\n${entityItems}\n</ul>`);
  }
  if (commsContext) {
    parts.push(commsContext);
  }
  if (nextStepItems) {
    parts.push(`<ul>\n${nextStepItems}\n</ul>`);
  }
  parts.push(`</body>`);
  return parts.join('\n');
}

/**
 * Convert ISO date or datetime to MM/DD/YYYY for human-readable display.
 * Handles both YYYY-MM-DD and YYYY-MM-DDTHH:mm:ss.sssZ forms.
 * @param {string} isoDate
 * @returns {string}
 */
function formatDate(isoDate) {
  const datePart = (isoDate || '').split('T')[0];
  const parts = datePart.split('-');
  if (parts.length !== 3) return isoDate || '';
  return `${parts[1]}/${parts[2]}/${parts[0]}`;
}

// ── Asana API helpers ──────────────────────────────────────────────────────────

/**
 * Update an Asana task's html_notes.
 * Logs and returns null on any error — never throws.
 *
 * @param {string} pat       - Asana PAT
 * @param {string} gid       - task GID
 * @param {string} htmlNotes - html_notes string
 * @returns {Promise<object|null>}
 */
export async function updateAsanaCard(pat, gid, htmlNotes) {
  try {
    const res = await fetch(`${ASANA_BASE}/tasks/${gid}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ data: { html_notes: htmlNotes } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`[followup-sweep] Asana PUT /tasks/${gid} failed: ${res.status}`, body);
      return null;
    }
    return body.data || body;
  } catch (err) {
    console.warn(`[followup-sweep] Asana updateAsanaCard error: ${err.message}`);
    return null;
  }
}

/**
 * Find an existing People board milestone by display_name.
 * Returns the GID string or null.
 *
 * @param {string} pat         - Asana PAT
 * @param {string} displayName - person's display_name to match
 * @returns {Promise<string|null>}
 */
async function findPeopleCard(pat, displayName) {
  try {
    const url = `${ASANA_BASE}/projects/${PEOPLE_BOARD_GID}/tasks?opt_fields=gid,name&limit=100`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.warn(`[followup-sweep] Asana GET tasks failed: ${res.status}`);
      return null;
    }
    const body = await res.json().catch(() => ({}));
    const tasks = body.data || [];
    const lower = displayName.toLowerCase();
    const match = tasks.find(t => t.name && t.name.toLowerCase() === lower);
    return match?.gid || null;
  } catch (err) {
    console.warn(`[followup-sweep] findPeopleCard error: ${err.message}`);
    return null;
  }
}

/**
 * Create a new milestone on the People board in the Researching section.
 * Returns the GID string or null.
 *
 * @param {string} pat         - Asana PAT
 * @param {string} displayName - person's display_name
 * @returns {Promise<string|null>}
 */
async function createPeopleCard(pat, displayName) {
  try {
    // WHY projects + workspace (not memberships alone): Asana rejects task
    // creation with memberships-only — it requires one of workspace/parent/
    // projects (HTTP 400 "You should specify one of workspace, parent,
    // projects"). The canonical pattern (scripts/asana-upsert-story.js) is:
    // create the milestone in the project, then a separate /sections/.../addTask
    // call moves it into the target section.
    const res = await fetch(`${ASANA_BASE}/tasks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        data: {
          name: displayName,
          resource_subtype: 'milestone',
          projects: [PEOPLE_BOARD_GID],
          workspace: WORKSPACE_GID,
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`[followup-sweep] Asana POST task (create card) failed: ${res.status}`, body);
      return null;
    }
    const gid = body.data?.gid || null;
    if (!gid) return null;

    // Move the new card into the Researching section. Failure here is
    // non-fatal — the card already exists on the board, just in the default
    // section; log and continue so the sweep still writes html_notes/subtasks.
    try {
      const moveRes = await fetch(`${ASANA_BASE}/sections/${RESEARCHING_SECTION_GID}/addTask`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${pat}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ data: { task: gid } }),
      });
      if (!moveRes.ok) {
        const moveBody = await moveRes.json().catch(() => ({}));
        console.warn(`[followup-sweep] Asana addTask to Researching failed: ${moveRes.status}`, moveBody);
      }
    } catch (err) {
      console.warn(`[followup-sweep] Asana addTask error: ${err.message}`);
    }
    return gid;
  } catch (err) {
    console.warn(`[followup-sweep] createPeopleCard error: ${err.message}`);
    return null;
  }
}

async function findCompaniesCard(pat, displayName) {
  try {
    const url = `${ASANA_BASE}/projects/${COMPANIES_BOARD_GID}/tasks?opt_fields=gid,name&limit=100`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/json' },
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const tasks = body.data || [];
    const lower = displayName.toLowerCase();
    return tasks.find(t => t.name && t.name.toLowerCase() === lower)?.gid || null;
  } catch (err) {
    console.warn(`[followup-sweep] findCompaniesCard error: ${err.message}`);
    return null;
  }
}

async function createCompaniesCard(pat, displayName) {
  try {
    const res = await fetch(`${ASANA_BASE}/tasks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        data: {
          name: displayName,
          resource_subtype: 'milestone',
          workspace: WORKSPACE_GID,
          projects: [COMPANIES_BOARD_GID],
        },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`[followup-sweep] Asana POST companies card failed: ${res.status}`, body);
      return null;
    }
    return body.data?.gid || null;
  } catch (err) {
    console.warn(`[followup-sweep] createCompaniesCard error: ${err.message}`);
    return null;
  }
}

/**
 * Create an Asana subtask under a parent card.
 * Returns the GID string or null.
 *
 * @param {string} pat       - Asana PAT
 * @param {string} parentGid - parent task GID
 * @param {string} name      - subtask name
 * @param {string} dueOn     - ISO date string (YYYY-MM-DD)
 * @returns {Promise<string|null>}
 */
async function createSubtask(pat, parentGid, name, dueOn) {
  try {
    const res = await fetch(`${ASANA_BASE}/tasks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${pat}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        data: { parent: parentGid, name, due_on: dueOn, assignee: 'me' },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn(`[followup-sweep] Asana POST subtask failed: ${res.status}`, body);
      return null;
    }
    return body.data?.gid || null;
  } catch (err) {
    console.warn(`[followup-sweep] createSubtask error: ${err.message}`);
    return null;
  }
}

// ── Haiku calls ────────────────────────────────────────────────────────────────

/**
 * Extract entities mentioned in a transcript via Haiku.
 *
 * Returns [{ name, type: 'person'|'company', email?: string, domain?: string }].
 * Never throws — returns [] on any error.
 *
 * @param {string} transcriptText
 * @param {string} ownerEmail - skip any entity whose email matches the owner
 * @returns {Promise<Array>}
 */
async function extractEntities(notesText, ownerEmail) {
  // Entities come from the owner's OWN post-call notes — curated, high-signal,
  // and intentional. The transcript is NOT mined for names: free-speech ASR
  // produced junk entities ("Sally", "Trey", a mis-transcribed "Panthelyssa").
  // The owner names who matters; the transcript only enriches and yields next
  // steps. No notes → no extracted entities (the call's attendees are already
  // seeded into the graph by granola-sync).
  if (!notesText || !notesText.trim()) return [];
  try {
    const msg = await llmCreate({
      model: modelFor('fast'),
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Extract the people and companies the owner named in these instructions.
These are the owner's own curated notes — every named person or company is intentional. Include them all.

Return a JSON array. Each item has:
  name: string (display name)
  type: "person" or "company"
  url: string or null — a research source URL ONLY if the owner wrote one:
       preferred: LinkedIn profile URL (linkedin.com/in/...) for a person,
       or Crunchbase (crunchbase.com/organization/...), LinkedIn company page, or website URL for a company or person.

TYPE RULES — apply in this order:
1. If the owner explicitly states an entity's type ("is a person", "is a company", "blogger", "not a company", "founder of", etc.), use that as the type. This overrides URL pattern inference.
2. linkedin.com/in/ → always "person". linkedin.com/company/ or crunchbase.com/organization/ → always "company".
3. For all other URLs (personal websites, unknown domains): infer from the entity name and context.

OTHER RULES:
- Include only clearly named people or companies, not generic references ("the team", "investors").
- Exclude the owner themselves (email: ${ownerEmail || 'unknown'}).
- Only set url to a link the owner actually wrote. Never invent a URL.
- Return ONLY the JSON array, no explanation.

Instructions:
${notesText.slice(0, 8000)}`,
      }],
    }, 'followup-extract-entities');
    const text = msg.content?.[0]?.text || '[]';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const raw = JSON.parse(match[0]);
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    console.warn(`[followup-sweep] extractEntities error: ${err.message}`);
    return [];
  }
}


/**
 * Extract explicit follow-up commitments from synthesis text via Haiku.
 *
 * Returns [{ task: string, dueDate: string|null }].
 * Returns [] when no explicit commitments found.
 * Never throws.
 *
 * @param {string} synthesisText
 * @returns {Promise<Array<{task: string, dueDate: string|null}>>}
 */
async function extractFollowUps(synthesisText) {
  try {
    const msg = await llmCreate({
      model: modelFor('fast'),
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Extract only explicit follow-up commitments from this call synthesis.
A commitment is a named action: a document to send, a meeting to schedule, a company to contact, a person to introduce.
General impressions, vague intentions, and "we should catch up soon" do NOT count.

Return a JSON array of objects with:
  task: string (specific action description)
  dueDate: string or null (ISO date YYYY-MM-DD if mentioned, otherwise null)

If no explicit commitments exist, return an empty array [].
Return ONLY the JSON array.

Source (owner notes and/or call transcript):
${synthesisText.slice(0, 8000)}`,
      }],
    }, 'followup-extract-tasks');
    const text = msg.content?.[0]?.text || '[]';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const raw = JSON.parse(match[0]);
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    console.warn(`[followup-sweep] extractFollowUps error: ${err.message}`);
    return [];
  }
}

/**
 * Synthesise call notes from available context via Haiku.
 *
 * Returns { summary, callContext, conclusion } where callContext is a 4–8 word
 * phrase describing the call topic (used to scope Brave Search queries).
 * Never throws — returns fallback strings on error.
 *
 * @param {object} context
 * @param {string} context.transcriptText
 * @param {string} context.emailContext
 * @param {string} context.iMessageContext
 * @param {string} [context.verbalNotes]
 * @returns {Promise<{summary: string, callContext: string, conclusion: string}>}
 */
async function synthesiseCallNotes(context) {
  try {
    const contextParts = [
      context.transcriptText ? `## Transcript\n${context.transcriptText.slice(0, 6000)}` : null,
      context.emailContext ? `## Recent emails\n${context.emailContext}` : null,
      context.iMessageContext ? `## iMessage frequency\n${context.iMessageContext}` : null,
      context.verbalNotes ? `## Owner notes\n${context.verbalNotes}` : null,
    ].filter(Boolean).join('\n\n');

    const msg = await llmCreate({
      model: modelFor('fast'),
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Synthesise concise call notes from the context below.

Return a JSON object with:
  summary: string (2–4 sentences summarising what was discussed and key outcomes)
  callContext: string (4–8 words describing the call topic, e.g. "AI startup funding round" — used for web research)
  conclusion: string (1–2 sentences on the relationship status or outcome)

Return ONLY the JSON object.

Context:
${contextParts}`,
      }],
    }, 'followup-synthesise-notes');
    const text = msg.content?.[0]?.text || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { summary: 'Call synthesis unavailable.', callContext: 'networking call', conclusion: '' };
    const raw = JSON.parse(match[0]);
    return {
      summary: raw.summary || 'Call synthesis unavailable.',
      callContext: raw.callContext || 'networking call',
      conclusion: raw.conclusion || '',
    };
  } catch (err) {
    console.warn(`[followup-sweep] synthesiseCallNotes error: ${err.message}`);
    return { summary: 'Call synthesis unavailable.', callContext: 'networking call', conclusion: '' };
  }
}

/**
 * Synthesise email + iMessage context into a single integrated communication sentence.
 *
 * Combines what's in the inbox (recent email thread topic/date) and SMS frequency
 * into one sentence so the Asana card shows where the relationship stands
 * communication-wise, not a list of individual messages.
 *
 * Returns empty string when there's nothing to synthesise.
 *
 * @param {string} emailContext     - raw email rows (subject/date/snippet)
 * @param {string} iMessageContext  - iMessage frequency summary string
 * @returns {Promise<string>}
 */
async function synthesiseComms(emailContext, iMessageContext) {
  if (!emailContext && !iMessageContext) return '';
  try {
    const parts = [
      emailContext ? `## Recent emails\n${emailContext}` : null,
      iMessageContext ? `## iMessage frequency\n${iMessageContext}` : null,
    ].filter(Boolean).join('\n\n');

    const msg = await llmCreate({
      model: modelFor('fast'),
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: `Summarise the communication history below into 1–2 sentences describing the current state of contact: what was discussed, when, and the overall cadence. Be specific about dates and topics. Do not list individual messages. Do not use markdown. Return only the summary sentence(s).

${parts}`,
      }],
    }, 'followup-synthesise-comms');
    return (msg.content?.[0]?.text || '').trim();
  } catch (err) {
    console.warn(`[followup-sweep] synthesiseComms error: ${err.message}`);
    return '';
  }
}

// ── Entity creation helpers ────────────────────────────────────────────────────

/**
 * Run a synchronous DB-write closure with bounded backoff on SQLITE_BUSY.
 *
 * WHY: this sweep writes to the live ~/.robotdojo/robotdojo.db while the
 * production server actively holds the same file open. lib/db.js sets
 * busy_timeout=30000, but under heavy write contention better-sqlite3 still
 * throws SQLITE_BUSY ('database is locked') rather than blocking. These entity
 * INSERT callsites are synchronous better-sqlite3 — no async/await available —
 * so the sleep must be a real synchronous pause. Atomics.wait on a throwaway
 * SharedArrayBuffer parks the thread for the backoff interval with no busy-wait
 * loop and no event-loop yield. Only SQLITE_BUSY is retried; any other error
 * (and exhausted retries) rethrows so genuine failures surface.
 *
 * @param {() => T} fn    - synchronous DB-write closure
 * @param {string}  label - context for the retry log line
 * @returns {T}
 * @template T
 */
// ── Context file writer ────────────────────────────────────────────────────────

/**
 * Write or append a research note to an entity's context file.
 *
 * If the context file already exists, appends under "## Post-call research ({date})" header.
 * If new, creates the file with the research note under that header.
 *
 * WHY fs.writeFileSync not canonical-write.js:
 *   canonical-write.js is for owner-curated canonical docs with budget enforcement.
 *   Entity context files are synthesis outputs — this is the correct direct write path
 *   (same pattern as context generation in the entity enrichment pipeline).
 *
 * @param {string} contextRelPath - relative path from REPO_ROOT
 * @param {string} date           - ISO date string (YYYY-MM-DD)
 * @param {string} note           - research note text
 * @returns {string} absolute path written
 */
function writeEntityContextNote(contextRelPath, date, note) {
  const absPath = resolvePath(REPO_ROOT, contextRelPath);
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });

  const header = `## Post-call research (${date})`;
  const section = `\n${header}\n\n${note}\n`;

  if (existsSync(absPath)) {
    const existing = readFileSync(absPath, 'utf8');
    writeFileSync(absPath, existing + section, 'utf8');
  } else {
    writeFileSync(absPath, section, 'utf8');
  }
  return absPath;
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Run a complete post-call synthesis sweep for a named entity (person or company).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} opts
 * @param {string} opts.entityName        - display name of the person or company
 * @param {'person'|'company'} [opts.entityType='person'] - entity type
 * @param {string} [opts.instructions]    - owner instructions (entities to research, context)
 * @param {string} [opts.personName]      - legacy alias for entityName
 * @param {string} [opts.verbalNotes]     - legacy alias for instructions
 * @returns {Promise<SweepResult>}
 *
 * @typedef {object} SweepResult
 * @property {string}   entityId         - people.id or companies.id
 * @property {string}   transcriptId     - transcript.id used
 * @property {string|null} asanaGid      - Asana task GID (null if Asana write failed)
 * @property {number}   subtasksCreated  - number of subtasks created
 * @property {number}   entitiesCreated  - count of newly created entities
 * @property {string[]} entityIds        - all entity IDs resolved from instructions
 * @property {string[]} contextFiles     - relative paths to context files written
 *
 * OR: { skipped: true, reason: string }
 */
export async function runFollowupSweep(db, opts = {}) {
  const entityName = opts.entityName || opts.personName;
  const entityType = opts.entityType || 'person';
  const instructions = opts.instructions || opts.verbalNotes || '';
  if (!entityName) return { skipped: true, reason: 'no entityName provided' };

  // ── 1–4. Load all DB context (entity, emails, transcript, comms context) ──
  const ctx = entityType === 'company'
    ? loadCompanyFollowupContext(db, entityName)
    : loadFollowupContext(db, entityName);
  if (ctx.skipped) return ctx;

  const entity = ctx.person || ctx.entity;
  const entityId = ctx.personId || ctx.entityId;
  const transcript = ctx.transcript;
  const emailContext = ctx.emailContext;
  const iMessageContext = ctx.iMessageContext || '';

  // ── 4b. Prefer attributed file over stripped DB column ─────────────────────
  // Granola writes speaker names to the file on disk ("person-a:", "person-b:").
  // The DB transcript_text column strips those to "Speaker:". Read the file when
  // it exists so synthesis sees correct attribution.
  let transcriptText = transcript.transcript_text || '';
  if (transcript.file_path) {
    try {
      const raw = readFileSync(transcript.file_path, 'utf8');
      transcriptText = raw.replace(/^---[\s\S]*?---\n?/, '').trim();
    } catch { /* file missing — fall back to transcript_text */ }
  }

  // ── 5. Synthesise call notes ────────────────────────────────────────────────
  const synthesis = await synthesiseCallNotes({
    transcriptText,
    emailContext,
    iMessageContext,
    verbalNotes: instructions,
  });

  const callDate = transcript.meeting_date || new Date().toISOString().slice(0, 10);

  // ── 5b. Synthesise integrated comms context (email + SMS) ──────────────────
  const commsContext = await synthesiseComms(emailContext, iMessageContext);

  // ── 6. Extract entities from the OWNER'S INSTRUCTIONS (curated, high-signal). ─
  const ownerEmail = config.ownerEmail || '';
  const noteEntities = await extractEntities(instructions, ownerEmail);

  // ── 7. Deep research each note-entity via the /profile skill. ──────────────
  // For each entity that has a source URL: resolve it deterministically
  // (resolveEntityFromUrl dedupes by URL → a STABLE entityId and context path,
  // the same identity /profile will resolve to), spawn /profile to do the live
  // LinkedIn/Crunchbase research, then VERIFY the context file was freshly
  // written this run (exists AND mtime ≥ sweep start). The verification is
  // deterministic — it never parses /profile's conversational prose — so the
  // sweep can never report a file that was not actually written. An entity with
  // no source URL gets no deep research and is never claimed as profiled.
  const CLAUDE_BIN = process.env.CLAUDE_BIN
    || process.env.ROBOTDOJO_CLAUDE_BIN
    || 'claude';
  const PROFILE_TIMEOUT_MS = 600000; // Crunchbase research can run several minutes.
  // Spawn /profile from a scratch dir OUTSIDE the repo. The Playwright MCP writes
  // debug output to `<cwd>/.playwright-mcp`; with cwd=REPO_ROOT that polluted the
  // repo root and tripped the root-lock gate on the next commit. /profile uses
  // global skills + absolute lib paths, so cwd does not affect its behaviour.
  const PROFILE_CWD = join(tmpdir(), 'robotdojo-profile-scratch');
  try { mkdirSync(PROFILE_CWD, { recursive: true }); } catch { /* best-effort */ }
  const sweepStartMs = Date.now();
  const entityIds = [];
  let entitiesCreated = 0;
  const entityData = []; // [{ name, url, bullets, entityId, contextRelPath }]
  const contextFiles = [];

  for (const ne of noteEntities) {
    const name = (ne.name || '').trim();
    if (!name) continue;
    const sourceUrl = (ne.url || '').trim();

    // No source URL → cannot research reliably. Note the name on the card so
    // the owner sees it was captured, but make no false claim of a profile.
    if (!sourceUrl) {
      entityData.push({ name, url: null, bullets: [], entityId: null, contextRelPath: null });
      continue;
    }

    // Resolve the entity deterministically up front (dedup by URL). This is the
    // same identity /profile will resolve to, so the path we verify matches the
    // path /profile writes.
    let resolved = null;
    try {
      resolved = await resolveEntityFromUrl(sourceUrl, name, db, ne.type || null);
    } catch (err) {
      console.warn(`[followup-sweep] could not resolve ${name} from ${sourceUrl}: ${err.message}`);
      entityData.push({ name, url: null, bullets: [], entityId: null, contextRelPath: null });
      continue;
    }
    if (resolved.created) entitiesCreated++;
    entityIds.push(resolved.entityId);

    let contextRelPath = null;
    try {
      contextRelPath = entityContextPath(resolved.entityType, resolved.entityId, db);
    } catch (err) {
      console.warn(`[followup-sweep] entityContextPath error for ${resolved.entityId}: ${err.message}`);
    }
    const cardUrl = buildEntityUrl(
      resolved.entityType === 'company' ? 'companies' : 'people', resolved.entityId, name, config,
    );

    // Spawn /profile to run live research + write the context file.
    try {
      const result = spawnSync(
        CLAUDE_BIN,
        ['--print', '--dangerously-skip-permissions', `/profile ${name} ${sourceUrl}`],
        { cwd: PROFILE_CWD, timeout: PROFILE_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      if (result.status !== 0) {
        console.warn(`[followup-sweep] /profile exited ${result.status}${result.signal ? '/' + result.signal : ''} for ${name}`);
      }
    } catch (err) {
      console.warn(`[followup-sweep] /profile spawn error for ${name}: ${err.message}`);
    }

    // Deterministic verification: the context file must exist AND have been
    // written this run. Only then is the entity counted as profiled.
    let profiled = false;
    const bullets = [];
    if (contextRelPath) {
      const absPath = resolvePath(REPO_ROOT, contextRelPath);
      try {
        if (existsSync(absPath) && statSync(absPath).mtimeMs >= sweepStartMs) {
          profiled = true;
          contextFiles.push(contextRelPath);
          const content = readFileSync(absPath, 'utf8');
          const aboutMatch = content.match(/^## About\n([\s\S]*?)(?=^## |$(?![\s\S]))/m);
          if (aboutMatch) {
            bullets.push(...aboutMatch[1].split('\n')
              .map(l => l.replace(/^[-*#]+\s*/, '').replace(/\*\*/g, '').trim())
              .filter(l => l
                && l.toLowerCase() !== name.toLowerCase()
                && l.length > 30  // skip bare section headers like "Current Role"
              )
              .slice(0, 2));
          }
        } else {
          console.warn(`[followup-sweep] ${name}: no fresh context file after /profile — not claiming a profile`);
        }
      } catch (err) {
        console.warn(`[followup-sweep] verify error for ${name}: ${err.message}`);
      }
    }

    entityData.push({
      name,
      url: profiled ? cardUrl : null,
      bullets,
      entityId: resolved.entityId,
      contextRelPath: profiled ? contextRelPath : null,
    });
  }

  // ── 8. Build html_notes ────────────────────────────────────────────────────
  const htmlNotes = buildHtmlNotes({
    date: callDate,
    source: 'Granola call',
    summary: synthesis.summary,
    entities: entityData.map(e => ({ name: e.name, url: e.url, bullets: e.bullets })),
    commsContext,
    nextSteps: [], // populated after subtask extraction
  });

  // ── 9. Get or create Asana card ────────────────────────────────────────────
  let asanaGid = null;
  const pat = readKeychainSecret('ASANA_PAT') || process.env.ASANA_PAT || null;
  const boardGid = entityType === 'company' ? COMPANIES_BOARD_GID : PEOPLE_BOARD_GID;
  if (pat && isConfiguredGid(boardGid)) {
    const displayName = entity.display_name || entity.name;
    if (entityType === 'company') {
      asanaGid = await findCompaniesCard(pat, displayName);
      if (!asanaGid) asanaGid = await createCompaniesCard(pat, displayName);
    } else {
      asanaGid = await findPeopleCard(pat, displayName);
      if (!asanaGid) asanaGid = await createPeopleCard(pat, displayName);
    }
  } else if (!pat) {
    console.warn('[followup-sweep] No ASANA_PAT found — skipping Asana writes');
  } else {
    console.warn(`[followup-sweep] ${entityType} board gid not configured (placeholder) — skipping Asana writes`);
  }

  // ── 10. Write html_notes to Asana card ────────────────────────────────────
  if (pat && asanaGid) {
    await updateAsanaCard(pat, asanaGid, htmlNotes);
  }

  // ── 11. Extract follow-ups and create subtasks ─────────────────────────────
  let subtasksCreated = 0;
  const nextDay = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

  if (pat && asanaGid) {
    const nextStepSource = [instructions, transcriptText]
      .filter(Boolean).join('\n\n');
    const followUps = await extractFollowUps(nextStepSource || synthesis.summary);
    if (followUps.length > 0) {
      // Branch A — explicit follow-ups found
      for (const item of followUps) {
        const due = item.dueDate || nextDay;
        const created = await createSubtask(pat, asanaGid, item.task, due);
        if (created) subtasksCreated++;
      }
    } else {
      // Branch B — no follow-ups: create review task
      const created = await createSubtask(
        pat,
        asanaGid,
        'Review post-call research and next steps',
        nextDay
      );
      if (created) subtasksCreated++;
    }
  }

  return {
    entityId,
    transcriptId: transcript.id,
    asanaGid,
    subtasksCreated,
    entitiesCreated,
    entityIds,
    contextFiles,
  };
}
