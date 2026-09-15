#!/usr/bin/env node
/**
 * Communication Style Analysis — computes per-person style profiles from
 * email/iMessage/calendar interaction patterns and stores them in people.notes.
 *
 * Features computed per person (10+ interactions):
 *   - Email verbosity ratio vs population baseline
 *   - Ghost rate (owner sends, no reply within 7d)
 *   - Initiation ratio (0=they always start, 1=owner always starts)
 *   - Channel mix (email_pct, imessage_pct, calendar_pct)
 *   - Thread depth (avg emails per shared thread)
 *   - Response reciprocity
 *
 * Results are merged into people.notes (JSON) under the `style` key.
 * Incremental: skips people where style was computed in last 30 days.
 *
 * CLI:
 *   node scripts/analyze-communication-style.js            # up to 100
 *   node scripts/analyze-communication-style.js --limit 50
 */
import db from '../lib/db.js';
import { ownerEmails } from '../lib/identity.js';

const args = process.argv.slice(2);
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 100;
const STALE_DAYS = 30;
const MIN_INTERACTIONS = 10;

const cutoffDate = new Date(Date.now() - STALE_DAYS * 86400000).toISOString();

// ── Owner identity ──────────────────────────────────────────────────────────
const OWNER_EMAILS = ownerEmails();
const ownerEmailSet = new Set(OWNER_EMAILS);

// ── Step 0: person-email lookup ─────────────────────────────────────────────
console.log('Step 0: building person-email lookup');
const personEmailRows = db.prepare(`
  SELECT person_id, LOWER(value) as email
  FROM person_identifiers WHERE type = 'email'
`).all();
const emailToPerson = new Map();
const personToEmails = new Map();
for (const row of personEmailRows) {
  emailToPerson.set(row.email, row.person_id);
  if (!personToEmails.has(row.person_id)) personToEmails.set(row.person_id, []);
  personToEmails.get(row.person_id).push(row.email);
}
console.log(`  ${emailToPerson.size} email→person mappings`);

// ── Step 1: candidates ──────────────────────────────────────────────────────
console.log('Step 1: selecting candidates');
const allPeople = db.prepare(`
  SELECT id, display_name, tier, interaction_count, notes
  FROM people
  WHERE interaction_count >= ?
    AND COALESCE(archived, 0) = 0
  ORDER BY interaction_count DESC
`).all(MIN_INTERACTIONS);

const candidates = allPeople.filter(p => {
  if (!p.notes) return true;
  try {
    const n = JSON.parse(p.notes);
    if (!n.style?.computed_at) return true;
    return new Date(n.style.computed_at) < new Date(cutoffDate);
  } catch { return true; }
}).slice(0, LIMIT);

console.log(`  ${allPeople.length} total → ${candidates.length} to process (limit=${LIMIT}, stale>${STALE_DAYS}d)`);
if (candidates.length === 0) {
  console.log('Nothing to process.');
  process.exit(0);
}

// ── Step 2: population email baseline ───────────────────────────────────────
console.log('Step 2: population email baseline');
const baseline = db.prepare(`
  SELECT AVG(LENGTH(body_text)) as avg_len
  FROM emails
  WHERE body_text IS NOT NULL AND LENGTH(body_text) > 10
`).get();
const BASELINE_LEN = baseline?.avg_len || 500;

// ── Step 3: email stats per sender ──────────────────────────────────────────
console.log('Step 3: email stats per sender');
const emailStats = db.prepare(`
  SELECT
    LOWER(sender_email) as email,
    COUNT(*) as count,
    AVG(LENGTH(body_text)) as avg_len
  FROM emails
  WHERE sender_email IS NOT NULL AND LENGTH(body_text) > 10
  GROUP BY LOWER(sender_email)
  HAVING count >= 3
`).all();
const emailStatMap = new Map();
for (const s of emailStats) emailStatMap.set(s.email, s);
console.log(`  ${emailStatMap.size} senders with stats`);

// ── Step 4: thread-based response analysis ───────────────────────────────────
console.log('Step 4: thread response analysis');
const candidateIds = new Set(candidates.map(c => c.id));

const threadEmails = db.prepare(`
  SELECT thread_id, LOWER(sender_email) as email, received_at
  FROM emails
  WHERE thread_id IS NOT NULL
    AND sender_email IS NOT NULL
    AND received_at IS NOT NULL
  ORDER BY thread_id, received_at
`).all();

const responseStats = new Map();

let currentThread = null;
let threadMsgs = [];

function processThread(msgs) {
  if (msgs.length < 2) return;
  const ownerInThread = msgs.some(m => ownerEmailSet.has(m.email));
  if (!ownerInThread) return;

  for (const msg of msgs) {
    if (ownerEmailSet.has(msg.email)) continue;
    const pid = emailToPerson.get(msg.email);
    if (!pid || !candidateIds.has(pid)) continue;

    if (!responseStats.has(pid)) {
      responseStats.set(pid, {
        shared_threads: 0,
        they_replied_to_owner: 0,
        owner_replied_to_them: 0,
        owner_awaiting_reply: 0,
        they_awaiting_reply: 0,
        owner_sent_last_no_reply: 0,
      });
    }
    const rs = responseStats.get(pid);

    const dyad = msgs.filter(m => ownerEmailSet.has(m.email) || m.email === msg.email);
    if (dyad.length < 2) continue;

    rs.shared_threads++;

    for (let i = 0; i < dyad.length - 1; i++) {
      const cur = ownerEmailSet.has(dyad[i].email) ? 'owner' : 'them';
      const nxt = ownerEmailSet.has(dyad[i + 1].email) ? 'owner' : 'them';
      if (cur === 'owner' && nxt === 'them') { rs.owner_awaiting_reply++; rs.they_replied_to_owner++; }
      else if (cur === 'them' && nxt === 'owner') { rs.they_awaiting_reply++; rs.owner_replied_to_them++; }
    }

    const last = dyad[dyad.length - 1];
    if (ownerEmailSet.has(last.email) && dyad.length >= 2) {
      rs.owner_awaiting_reply++;
      rs.owner_sent_last_no_reply++;
    }
  }
}

for (const msg of threadEmails) {
  if (msg.thread_id !== currentThread) {
    if (threadMsgs.length > 0) processThread(threadMsgs);
    currentThread = msg.thread_id;
    threadMsgs = [];
  }
  threadMsgs.push(msg);
}
if (threadMsgs.length > 0) processThread(threadMsgs);
console.log(`  Response stats for ${responseStats.size} people`);

// ── Step 5: channel mix per person ───────────────────────────────────────────
console.log('Step 5: channel mix');
const channelRows = db.prepare(`
  SELECT person_id, channel, direction, COUNT(*) as c
  FROM person_interactions
  GROUP BY person_id, channel, direction
`).all();
const channelMap = new Map();
for (const row of channelRows) {
  if (!candidateIds.has(row.person_id)) continue;
  if (!channelMap.has(row.person_id)) channelMap.set(row.person_id, { email: 0, imessage: 0, calendar: 0 });
  const cm = channelMap.get(row.person_id);
  if (row.channel === 'email') cm.email += row.c;
  else if (row.channel === 'imessage') cm.imessage += row.c;
  else if (row.channel === 'calendar') cm.calendar += row.c;
}
console.log(`  Channel mix for ${channelMap.size} people`);

// ── Step 6: initiation ratio from interaction directions ────────────────────
console.log('Step 6: initiation ratios');
const initiationRows = db.prepare(`
  SELECT person_id,
    SUM(CASE WHEN direction IN ('outbound','group_out') THEN 1 ELSE 0 END) as out_cnt,
    COUNT(*) as total_cnt
  FROM person_interactions
  GROUP BY person_id
`).all();
const initiationMap = new Map();
for (const row of initiationRows) {
  if (!candidateIds.has(row.person_id)) continue;
  initiationMap.set(row.person_id, {
    ratio: row.total_cnt > 0 ? row.out_cnt / row.total_cnt : null,
    total: row.total_cnt,
  });
}

// ── Step 7: compute + store results ─────────────────────────────────────────
console.log('Step 7: computing features + storing');

const updateNotes = db.prepare('UPDATE people SET notes = ?, updated_at = datetime(\'now\') WHERE id = ?');

let processed = 0;

db.transaction(() => {
  for (const person of candidates) {
    const emails = personToEmails.get(person.id) || [];

    // Email verbosity
    let emailCount = 0, totalLen = 0;
    for (const email of emails) {
      const stat = emailStatMap.get(email);
      if (stat) { emailCount += stat.count; totalLen += (stat.avg_len || 0) * stat.count; }
    }
    const avgEmailLen = emailCount > 0 ? totalLen / emailCount : 0;
    const verbosityRatio = BASELINE_LEN > 0 ? Math.round((avgEmailLen / BASELINE_LEN) * 100) / 100 : null;

    // Response behavior
    const rs = responseStats.get(person.id);
    const ghostRate = rs && rs.owner_awaiting_reply > 5
      ? Math.round((rs.owner_sent_last_no_reply / rs.owner_awaiting_reply) * 100) / 100 : null;
    const replyRate = rs && rs.owner_awaiting_reply > 5
      ? Math.round((rs.they_replied_to_owner / rs.owner_awaiting_reply) * 100) / 100 : null;
    const threadDepth = rs && rs.shared_threads > 0
      ? Math.round(((rs.they_replied_to_owner + rs.owner_replied_to_them) / rs.shared_threads) * 100) / 100 : null;

    // Channel mix
    const cm = channelMap.get(person.id) || { email: 0, imessage: 0, calendar: 0 };
    const chanTotal = cm.email + cm.imessage + cm.calendar || 1;
    const emailPct = Math.round((cm.email / chanTotal) * 100) / 100;
    const imessagePct = Math.round((cm.imessage / chanTotal) * 100) / 100;
    const calendarPct = Math.round((cm.calendar / chanTotal) * 100) / 100;

    // Initiation
    const init = initiationMap.get(person.id);
    const initiationRatio = init?.total >= 5 ? Math.round((init.ratio || 0) * 100) / 100 : null;

    const style = {
      verbosity_ratio: verbosityRatio,
      ghost_rate: ghostRate,
      reply_rate: replyRate,
      initiation_ratio: initiationRatio,
      thread_depth: threadDepth,
      channel_mix: { email: emailPct, imessage: imessagePct, calendar: calendarPct },
      email_count: emailCount,
      shared_threads: rs?.shared_threads ?? 0,
      computed_at: new Date().toISOString(),
    };

    let existing = {};
    try { if (person.notes) existing = JSON.parse(person.notes); } catch {}

    updateNotes.run(JSON.stringify({ ...existing, style }), person.id);
    processed++;
  }
})();

console.log(`\nStyle analysis complete: ${processed} people updated`);

// ── Summary ──────────────────────────────────────────────────────────────────
const ghosters = candidates
  .map(p => {
    const rs = responseStats.get(p.id);
    const gr = rs && rs.owner_awaiting_reply > 5
      ? rs.owner_sent_last_no_reply / rs.owner_awaiting_reply : null;
    return { name: p.display_name, ghost_rate: gr, threads: rs?.shared_threads ?? 0 };
  })
  .filter(r => r.ghost_rate !== null && r.ghost_rate > 0.3)
  .sort((a, b) => b.ghost_rate - a.ghost_rate)
  .slice(0, 10);

if (ghosters.length > 0) {
  console.log('\n=== HIGH GHOST RATES ===');
  for (const g of ghosters) {
    console.log(`  ${(g.ghost_rate * 100).toFixed(0).padStart(3)}%  ${g.name}  (${g.threads} threads)`);
  }
}
