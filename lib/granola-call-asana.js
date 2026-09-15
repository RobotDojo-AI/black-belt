/**
 * Granola call summary -> Asana task.
 *
 * One future task per Granola transcript. The destination (workspace, token,
 * and — for org workspaces — project) is resolved from the transcript's topic
 * via config/asana-routing.json (df_e1dcf732 AC9: gids live in config, never
 * as code literals). The passive job unique key is the idempotency boundary.
 */
export const INTELLIGENCE_TIER = 'synthesis';

import { llmCreate } from './llm-gateway.js';
import { readKeychainSecret } from './keychain.js';
import { enqueuePassiveJob } from './passive-jobs.js';
import { resolveRoster, firstNameAliases, tokenSet } from './transcript-roster.js';
import { ownerDisplayName, ownerPersonId } from './identity.js';
import { asanaDestinationForTopic, destinationKeyForTopic } from './call-routing.js';
import { fetchGranolaListMembership } from './granola-client.js';
import { modelFor } from './model-lane.js';

export const GRANOLA_CALL_ASANA_JOB_TYPE = 'granola_call_asana';

const ASANA_BASE = 'https://app.asana.com/api/1.0';

// df_1231887c — NON-ROUTING topic->destination mapper. Retained only for
// reporting callers and its unit tests; the live Granola routing path is now
// asanaTargetFromFolder (folder membership, never `topic`). The dead
// `row.tag || row.granola_tag` fallbacks are removed — `transcripts` has no
// such column, so they never carried a value. "Primary work" = any topic that
// routes to a dedicated (non-default) Asana destination — config-driven, so no
// employer slug is hardcoded (the owner's work slug lives in the routing override).
export function isPrimaryWorkTranscript(row = {}) {
  return destinationKeyForTopic(row.topic) !== 'default';
}

/**
 * NON-ROUTING topic->destination mapper (df_1231887c). Retained for reporting
 * callers / unit tests only — routing no longer reads `transcripts.topic`
 * (see asanaTargetFromFolder). Returns the declarative routing row
 * (config/asana-routing.json): { provider, tokenName, workspace, project,
 * label }. `project` is set for org workspaces (a projectless task in an
 * organization is near-invisible) and null for the primary personal
 * workspace (tasks land in My Tasks via assignee, unchanged).
 */
export function asanaTargetForTranscript(row = {}) {
  return asanaDestinationForTopic(row.topic);
}

/**
 * df_1231887c — THE routing decision, decoupled from `transcripts.topic`.
 *
 * The Granola folder membership map (granolaDocId -> routed slug), read fresh
 * at task-creation time, is the ONLY routing signal. `topic` is never read
 * here: the RAG maintenance pass (05-reclassify-chunks -> repair-source-topic-
 * metadata) rewrites `topic` to a life-topic AFTER sync, which is exactly what
 * mis-routed work calls to personal. A `meeting_id` absent from the map
 * (or a null lookup) yields null -> asanaDestinationForTopic's 'default' ->
 * personal, by construction. Pure and side-effect free so it is unit-testable
 * with an injected Map.
 */
export function asanaTargetFromFolder(meetingId, membership) {
  return asanaDestinationForTopic((membership && membership.get(meetingId)) || null);
}

function readAsanaPat(tokenName) {
  const envValue = process.env[tokenName];
  if (envValue) return envValue;
  return readKeychainSecret(tokenName);
}

function permanentError(message) {
  const err = new Error(message);
  err.quarantine = true;
  return err;
}

function cleanLine(value, fallback = '') {
  return String(value || fallback)
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanBullets(values, fallback) {
  const out = [];
  for (const value of values || []) {
    const line = cleanLine(value);
    if (line) out.push(line.replace(/^[-*]\s*/, ''));
  }
  // df_33f550b7 (owner call, this exchange) — no per-list cap. The former
  // slice(0, 8) was arbitrary and, after owner-label merging, could drop real
  // follow-ups for a person with many items. Every captured item is kept.
  return out.length ? out : [fallback];
}

function parseJsonObject(text) {
  if (!text) return {};
  const stripped = String(text).replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(stripped); } catch { /* salvage below */ }
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try { return JSON.parse(match[0]); } catch { return {}; }
}

function truncateMiddle(text, maxChars = 90000) {
  const body = String(text || '');
  if (body.length <= maxChars) return body;
  const head = Math.floor(maxChars * 0.45);
  const tail = maxChars - head;
  return `${body.slice(0, head)}\n\n[...middle omitted...]\n\n${body.slice(-tail)}`;
}

function speakerDisplayName(database, personId) {
  if (!personId) return null;
  if (personId === ownerPersonId()) return ownerDisplayName();
  try {
    const row = database.prepare('SELECT display_name FROM people WHERE id = ?').get(personId);
    return cleanLine(row?.display_name);
  } catch {
    return null;
  }
}

export function speakerNamesForTranscript(database, transcriptRow) {
  const speakers = new Set();

  try {
    const { candidates } = resolveRoster(database, transcriptRow);
    for (const candidate of candidates || []) {
      const name = cleanLine(candidate.name) || speakerDisplayName(database, candidate.personId);
      if (name) speakers.add(name);
    }
  } catch {
    // Minimal test DBs may not carry the calendar/person schema. Segment names
    // below still give the summarizer the best available roster.
  }

  try {
    const rows = database.prepare(`
      SELECT DISTINCT s.speaker_person_id, p.display_name AS speaker_name
        FROM transcript_segments s
        JOIN people p ON p.id = s.speaker_person_id
       WHERE s.transcript_id = ?
         AND s.speaker_person_id IS NOT NULL
       ORDER BY p.display_name
    `).all(transcriptRow.id);
    for (const row of rows) {
      const name = cleanLine(speakerDisplayName(database, row.speaker_person_id) || row.speaker_name);
      if (name) speakers.add(name);
    }
  } catch {
    // No segment table in a narrow test fixture.
  }

  return [...speakers];
}

export function renderTranscriptForSummary(database, transcriptRow) {
  try {
    const rows = database.prepare(`
      SELECT s.turn_index, s.source, s.text, s.speaker_person_id, p.display_name AS speaker_name
        FROM transcript_segments s
        LEFT JOIN people p ON p.id = s.speaker_person_id
       WHERE s.transcript_id = ?
       ORDER BY s.turn_index ASC
    `).all(transcriptRow.id);
    if (rows.length > 0) {
      return rows.map((row) => {
        const fallback = row.source === 'microphone' ? 'Owner' : 'Unassigned speaker';
        const name = speakerDisplayName(database, row.speaker_person_id) || row.speaker_name;
        return `${cleanLine(name, fallback)}: ${row.text || ''}`.trim();
      }).join('\n');
    }
  } catch {
    // Fall through to the legacy flat transcript text.
  }
  return transcriptRow.transcript_text || '';
}

function actionItemsBySpeaker(rawItems, speakers) {
  const bySpeaker = new Map();
  for (const speaker of speakers || []) bySpeaker.set(speaker, []);

  for (const item of rawItems || []) {
    const speaker = cleanLine(item?.speaker || item?.person || item?.owner || 'Unknown');
    const actions = Array.isArray(item?.items)
      ? item.items
      : [item?.action || item?.item || item?.task].filter(Boolean);
    if (!bySpeaker.has(speaker)) bySpeaker.set(speaker, []);
    bySpeaker.get(speaker).push(...actions.map((x) => cleanLine(x)).filter(Boolean));
  }

  if (bySpeaker.size === 0) {
    bySpeaker.set('No speaker assigned', ['No explicit action items captured.']);
  }

  const normalized = [];
  for (const [speaker, items] of bySpeaker) {
    normalized.push({
      speaker,
      // df_33f550b7 (owner call) — no cap; keep every captured action item.
      items: items.length ? items : ['No explicit action items captured.'],
    });
  }
  return normalized;
}

export function formatCallTaskNotes({ summaryBullets, actionItems }) {
  const summary = cleanBullets(summaryBullets, 'No substantive summary captured.')
    .map((line) => `- ${line}`)
    .join('\n');

  // df_33f550b7 — "Next Steps" (was "Action items"), grouped under each owner:
  // the owner name on its own line, then that person's items bulleted beneath,
  // a blank line between owner groups (was a single flat "- speaker: item"
  // list). Owner names are already reconciled to resolved invite entities by
  // the caller (createGranolaCallAsanaTask → reconcileActionItemOwners). Plain
  // text on the `notes` field — html_notes would add a 400 surface for no gain.
  const groups = [];
  for (const group of actionItems || []) {
    const speaker = cleanLine(group.speaker, 'Unknown');
    const items = cleanBullets(group.items, 'No explicit action items captured.');
    groups.push([speaker, ...items.map((item) => `- ${item}`)].join('\n'));
  }

  return [
    'Summary',
    summary,
    '',
    'Next Steps',
    groups.length ? groups.join('\n\n') : '- No explicit action items captured.',
  ].join('\n');
}

/**
 * df_33f550b7 — deterministic reconciliation of an LLM-derived action-item
 * speaker to a resolved calendar-invite entity. Tier 0: no LLM in the identity
 * path (identity decisions never go to a model). Normalize the speaker string
 * and match it — first-name nickname alias OR full-name token containment,
 * reusing transcript-roster's shared normalizers — against, in order:
 *   1. the owner (a first-name alias resolves to the owner's display name), then
 *   2. each roster candidate's resolved `name`.
 * On a match, return the canonical resolved name. On a MISS, return the speaker
 * string UNCHANGED — never dropped, never blanked, never bucketed as
 * "Unassigned" (AC3 no-drop guarantee: an owner the invite can't resolve is
 * preserved as given so no real follow-up disappears). Conservative by design
 * (failure manifest #4): an ambiguous/unknown speaker preserves rather than
 * guessing, so two different people are never merged onto one wrong name.
 *
 * @param {string} speaker — the LLM's speaker label for an action-item group
 * @param {Array<{name?:string}>} roster — resolveRoster candidates
 * @param {string} ownerName — the owner's canonical display name
 * @returns {string} canonical resolved name, or the speaker unchanged on a miss
 */
// df_33f550b7 (owner call, this exchange) — the Next Steps owner label shows the
// resolved person's FIRST name only, not the full display name. Handles
// "First Last" (first token) and imported "Last, First" (token after the
// comma). Applied only to a resolved match; an unmatched owner is preserved
// verbatim below, so a non-person label is never mangled.
function firstNameOf(fullName) {
  const s = cleanLine(fullName);
  if (!s) return s;
  if (s.includes(',')) {
    const after = s.split(',')[1]?.trim();
    if (after) return after.split(/\s+/)[0];
  }
  return s.split(/\s+/)[0];
}

export function reconcileOwnerName(speaker, roster, ownerName) {
  const raw = cleanLine(speaker);
  if (!raw) return speaker;
  if (ownerName && namesMatch(raw, ownerName)) return firstNameOf(ownerName);
  for (const candidate of roster || []) {
    const name = cleanLine(candidate?.name);
    if (name && namesMatch(raw, name)) return firstNameOf(name);
  }
  return speaker; // no match → preserve verbatim (never drop)
}

// Deterministic name match: a shared first-name nickname alias, or one name's
// word tokens fully contained in the other's (covers a first name vs its full
// name — "Sam" vs "Sam Rivera"). Uses transcript-roster's normalizers so the
// match stays consistent with the roster resolution itself.
function namesMatch(a, b) {
  const aFirst = firstNameAliases(a);
  const bFirst = firstNameAliases(b);
  for (const alias of aFirst) if (bFirst.has(alias)) return true;
  const aTokens = tokenSet(a);
  const bTokens = tokenSet(b);
  if (!aTokens.size || !bTokens.size) return false;
  const [small, large] = aTokens.size <= bTokens.size ? [aTokens, bTokens] : [bTokens, aTokens];
  for (const token of small) if (!large.has(token)) return false;
  return true;
}

/**
 * df_33f550b7 — reconcile every action-item group's speaker to a resolved
 * invite entity (reconcileOwnerName) and merge groups that land on the same
 * canonical owner. No action item is lost: count-in equals count-out, and (owner
 * call, this exchange) the former per-owner item cap has been removed, so a
 * merged owner keeps every item. Deterministic; no LLM.
 */
export function reconcileActionItemOwners(actionItems, roster, ownerName) {
  const byOwner = new Map();
  for (const group of actionItems || []) {
    const canonical = reconcileOwnerName(group?.speaker, roster, ownerName);
    if (!byOwner.has(canonical)) byOwner.set(canonical, []);
    const items = Array.isArray(group?.items) ? group.items : [];
    byOwner.get(canonical).push(...items);
  }
  const merged = [];
  for (const [speaker, items] of byOwner) merged.push({ speaker, items });
  return merged;
}

export async function synthesizeCallTask({ transcriptRow, transcriptText, speakers, client = null }) {
  const roster = speakers.length ? speakers.join(', ') : 'No roster names resolved';
  const prompt = [
    'Create an Asana task description for this meeting transcript.',
    'Return strict JSON only with this shape:',
    '{"summary_bullets":["short bullet"],"action_items":[{"speaker":"Name","items":["specific action"]}]}',
    'Rules:',
    '- summary_bullets: 3 to 6 concise bullets.',
    '- action_items: group concrete follow-ups by speaker.',
    '- Use the exact speaker names from the roster when possible.',
    '- If a speaker has no explicit action, omit them; the caller will add a no-action line.',
    '- Do not invent deadlines or tasks.',
    '',
    `Title: ${transcriptRow.title || 'Granola call'}`,
    `Date: ${transcriptRow.meeting_date || ''}`,
    `Roster: ${roster}`,
    '',
    'Transcript:',
    truncateMiddle(transcriptText),
  ].join('\n');

  // st_4312c9c0 AC-5 — routed through the gateway so the call is recorded.
  // The optional `client` argument survives for tests that inject a stub; when
  // one is supplied it is used directly and the call is NOT recorded, because a
  // stubbed response is not spend.
  const msg = client
    ? await client.messages.create({
      model: modelFor('fast'),
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    })
    : await llmCreate({
      model: modelFor('fast'),
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }, 'granola-call-summary');
  const raw = (msg.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const parsed = parseJsonObject(raw);
  return {
    summaryBullets: cleanBullets(parsed.summary_bullets, 'No substantive summary captured.'),
    actionItems: actionItemsBySpeaker(parsed.action_items, speakers),
  };
}

async function createAsanaTask({ pat, workspace, project = null, name, notes, fetchImpl = fetch }) {
  const body = JSON.stringify({
    data: {
      name,
      notes,
      workspace,
      assignee: 'me',
      // df_e1dcf732 AC2 — org-workspace destinations pin a project so the task
      // is visible where the owner works (an org task with only workspace +
      // assignee is near-unqueryable). The primary personal workspace stays
      // projectless: My Tasks via assignee, exactly as before.
      ...(project ? { projects: [project] } : {}),
    },
  });

  async function post() {
    return fetchImpl(`${ASANA_BASE}/tasks`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
    });
  }

  let res = await post();
  if (res.status === 429) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    res = await post();
  }

  const json = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    throw permanentError(`Asana ${res.status}: ${json?.errors?.[0]?.message || 'authorization required'}`);
  }
  if (!res.ok) {
    throw new Error(`Asana ${res.status}: ${json?.errors?.[0]?.message || res.statusText || 'task create failed'}`);
  }
  return json?.data?.gid || null;
}

export function enqueueGranolaCallAsanaTask(database, transcriptRow, opts = {}) {
  const transcriptId = typeof transcriptRow === 'string' ? transcriptRow : transcriptRow?.id;
  if (!transcriptId) throw new Error('enqueueGranolaCallAsanaTask: transcript id required');
  return enqueuePassiveJob({
    database,
    jobType: GRANOLA_CALL_ASANA_JOB_TYPE,
    uniqueKey: `${GRANOLA_CALL_ASANA_JOB_TYPE}:${transcriptId}`,
    targetType: 'transcript',
    targetId: transcriptId,
    priority: opts.priority ?? 46,
    timeoutMs: opts.timeoutMs ?? 120_000,
    maxAttempts: opts.maxAttempts ?? 5,
    payload: { transcriptId },
    metadata: {
      source: opts.source || 'granola-sync',
      topic: typeof transcriptRow === 'object' ? (transcriptRow.topic || null) : null,
    },
  });
}

export async function createGranolaCallAsanaTask({
  database,
  transcriptId,
  fetchImpl = fetch,
  client = null,
  synthesis = null,
  dryRun = false,
  folderMembership = null, // df_1231887c — Map<granolaDocId,slug>; live = fresh fetch, tests inject
} = {}) {
  if (!database) throw new Error('createGranolaCallAsanaTask: database required');
  if (!transcriptId) throw new Error('createGranolaCallAsanaTask: transcriptId required');

  // df_02d633dc — always read the live row fresh (this SELECT, never a cached
  // value) so a retry after a crash, a lease-expiry reclaim, or a benign
  // requeue sees whatever the previous attempt actually wrote to
  // asana_call_task_gid, not stale in-process state.
  const transcriptRow = database.prepare("SELECT * FROM transcripts WHERE id = ? AND source = 'granola'").get(transcriptId);
  if (!transcriptRow) throw permanentError(`Granola transcript not found: ${transcriptId}`);
  if (!cleanLine(transcriptRow.transcript_text)) throw permanentError(`Granola transcript has no text: ${transcriptId}`);

  // df_1231887c — route by the Granola folder membership read fresh HERE, never
  // by transcriptRow.topic. `topic` is overloaded (Asana routing + the RAG
  // life-topic taxonomy) and the RAG maintenance pass overwrites it to a
  // life-topic after sync, so reading it here mis-routed work calls to
  // personal. Live path fetches membership; tests inject a Map. An EMPTY map
  // means the local Granola cache was unreadable (hundreds of work-folder docs
  // exist live, so empty = read failure, never "no folders").
  const existingGid = cleanLine(transcriptRow.asana_call_task_gid);
  const membership = folderMembership ?? await fetchGranolaListMembership();
  if (membership.size === 0 && !existingGid) {
    // Inconclusive read with no task yet: a PLAIN (retryable) Error, NOT
    // permanentError. The passive job increments attempts, backs off, and
    // requeues; on maxAttempts it quarantines VISIBLY under EXTERNAL_CONNECTOR.
    // It never creates a personal task and dedup-locks a transient misroute.
    // The existingGid check above runs FIRST, so an already-created task never
    // re-defers on a momentary unreadable cache.
    throw new Error(`granola folder membership unreadable — deferring asana route for ${transcriptId}`);
  }
  const target = asanaTargetFromFolder(transcriptRow.meeting_id, membership);
  const date = String(transcriptRow.meeting_date || '').slice(0, 10);
  const title = cleanLine(transcriptRow.title, 'Granola call');
  const name = cleanLine(`${date ? `${date} - ` : ''}${title}`).slice(0, 200);

  // df_02d633dc — dedup guard (check-before-create). If a prior attempt already
  // created the Asana task and recorded its gid on this transcript, never POST
  // again: return the existing gid in the same shape as a fresh create. This is
  // what makes a retry / reclaim / partial-crash re-run idempotent. Checked
  // before the (LLM) synthesis and the POST so a duplicate attempt costs neither
  // a Haiku call nor an Asana write. Also honored under dryRun, per the plan.
  if (existingGid) {
    return { gid: existingGid, provider: target.provider, workspace: target.workspace, name };
  }

  const speakers = speakerNamesForTranscript(database, transcriptRow);
  const transcriptText = renderTranscriptForSummary(database, transcriptRow);
  const callSynthesis = synthesis || await synthesizeCallTask({ transcriptRow, transcriptText, speakers, client });

  // df_33f550b7 — reconcile each action-item owner to a resolved invite entity
  // before rendering. resolveRoster gives the invite candidates; ownerDisplayName
  // gives the owner's canonical name. Deterministic — no LLM in the identity
  // path. An unmatched owner is preserved verbatim (never dropped).
  let roster = [];
  try {
    roster = resolveRoster(database, transcriptRow).candidates || [];
  } catch {
    // Minimal test DBs may lack the calendar/person schema; reconcile then
    // preserves each speaker as given (no drop).
  }
  const reconciledActionItems = reconcileActionItemOwners(callSynthesis.actionItems, roster, ownerDisplayName());
  const notes = formatCallTaskNotes({ summaryBullets: callSynthesis.summaryBullets, actionItems: reconciledActionItems });

  if (dryRun) {
    return { dryRun: true, provider: target.provider, workspace: target.workspace, name, notes };
  }

  const pat = readAsanaPat(target.tokenName);
  if (!pat) throw permanentError(`${target.tokenName} not configured`);

  const gid = await createAsanaTask({
    pat,
    workspace: target.workspace,
    project: target.project || null,
    name,
    notes,
    fetchImpl,
  });

  // df_02d633dc — write the gid back to the transcripts row SYNCHRONOUSLY here,
  // immediately after the POST resolves and before returning — NOT deferred to
  // completePassiveJob's metadata write (a different function, after the handler
  // returns, exactly the step a crash can skip). This shrinks the un-recoverable
  // duplicate-POST window to one atomic UPDATE.
  if (gid) {
    database.prepare('UPDATE transcripts SET asana_call_task_gid = ? WHERE id = ?').run(gid, transcriptId);
  }

  return { gid, provider: target.provider, workspace: target.workspace, name };
}
