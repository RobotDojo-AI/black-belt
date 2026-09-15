/**
 * lib/relation-questions.js — the relationship question queue DAL
 * (st_f67bc2eb D8).
 *
 * Inference promotes attention and generates questions; it never writes an
 * edge (the Buzz/PYMK firewall). Every candidate relationship that cannot be
 * written under the authority rules lands here as a one-line question the
 * owner can answer in a word. The owner's answer is applied by
 * lib/relation-store.js applyQuestionAnswer — the ONE edge write path — so
 * this module stays a pure queue DAL with no edge writes of its own.
 *
 * Lifecycle (every pattern copied from proven surfaces):
 *   open      — enqueued, never shown
 *   asked     — surfaced in a chat conversation (asked_conversation_id set)
 *   confirmed — answered; the answer's effect (edge write / deprecate) is
 *               recorded by the store
 *   declined  — the owner said no. PERMANENT: the row is never deleted and
 *               its dedup_key blocks re-insert forever, so a declined
 *               candidate is never re-asked (AC-6).
 *
 * INVISIBILITY CONTRACT: no chat-context, prompt, RAG, or ego surface may
 * read relation_questions — queue rows are structurally invisible to the
 * model until the owner answers (grep-enforced criterion). Surfacing happens
 * post-stream in routes/chat.js only.
 *
 * Tier 0 — deterministic SQL. No LLM anywhere near this table.
 */

// Tier cutoff (scope A1 addendum, owner-adjudicated): questions and
// disambiguations are generated only for candidates in the top relationship
// tiers — core and network ("close"). The third tier (acquaintance) sits
// BELOW the question floor: acquaintance-grade ambiguity is exactly what the
// owner refused to adjudicate ("how relevant if you can't tell which person
// it is?"). Below → silence with reason below-tier-cutoff.
export const QUESTION_TIER_ALLOWED = new Set(['core', 'network']);

/** True when the person's best relationship tier clears the question floor. */
export function clearsTierCutoff(db, personId) {
  if (!personId) return true; // structural rows (no subject) judged elsewhere
  try {
    const p = db.prepare('SELECT personal_tier, business_tier FROM people WHERE id = ?').get(String(personId));
    if (!p) return false;
    return QUESTION_TIER_ALLOWED.has(String(p.personal_tier)) || QUESTION_TIER_ALLOWED.has(String(p.business_tier));
  } catch { return true; }
}

/** Deterministic dedup key: a declined (subject, object, rel_type, kind) can never re-enter. */
export function questionDedupKey({ subjectPersonId = null, objectPersonId = null, relType = null, kind }) {
  return [subjectPersonId || '', objectPersonId || '', relType || '', kind].join('|');
}

/**
 * Enqueue a candidate question. INSERT OR IGNORE against dedup_key — an
 * existing row of ANY status (open, asked, confirmed, declined) blocks the
 * insert, which is what makes a decline permanent.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} q
 * @param {'confirm'|'disambiguate'|'decompose'|'conflict'|'cross-anchor'} q.kind
 * @param {string|null} [q.subjectPersonId]
 * @param {string|null} [q.objectPersonId]
 * @param {string|null} [q.relType]
 * @param {string} q.questionText - one line, answerable in a word
 * @param {object} [q.payload] - candidates / evidence refs / decomposition options
 * @param {number} [q.confidence]
 * @param {number} [q.priority] - expected information gain
 * @param {string|null} [q.conflictReason] - names WHY this needs the owner
 *   (AC-12: every surviving open question is a genuine, named ambiguity)
 * @returns {{ id: number|null, inserted: boolean }}
 */
export function enqueueRelationQuestion(db, q) {
  const kind = String(q.kind || '').trim();
  // TIER CUTOFF (scope A1 addendum): candidate GENERATION (confirm /
  // disambiguate / decompose) requires a subject above the floor. Store-
  // generated 'conflict' and 'cross-anchor' rows are exempt — they arise from
  // evidence-backed write attempts against recorded truth (genuine conflicts
  // by construction; the resolver's lattice/exclusivity/stakes rules already
  // silence the junk ones).
  if (['confirm', 'disambiguate', 'decompose'].includes(kind)
    && q.subjectPersonId && !clearsTierCutoff(db, q.subjectPersonId)) {
    return { id: null, inserted: false, silenced: 'below-tier-cutoff' };
  }
  // PERSON-ONLY guard (st_f67bc2eb, owner QC round): a candidate whose
  // subject or object is a service/system artifact ("Are you Facebook's
  // friend?") is junk — never asked, never inserted. service_vendor=1 is the
  // pipeline's deterministic non-person marker (03b).
  try {
    const sv = db.prepare('SELECT COALESCE(service_vendor, 0) AS sv FROM people WHERE id = ?');
    for (const end of [q.subjectPersonId, q.objectPersonId]) {
      if (end && Number(sv.get(String(end))?.sv) === 1) {
        return { id: null, inserted: false, silenced: 'non-person-entity' };
      }
    }
  } catch { /* people table absent in minimal fixtures */ }
  const dedupKey = questionDedupKey({
    subjectPersonId: q.subjectPersonId,
    objectPersonId: q.objectPersonId,
    relType: q.relType,
    kind,
  });
  const res = db.prepare(`
    INSERT OR IGNORE INTO relation_questions
      (kind, dedup_key, subject_person_id, object_person_id, rel_type,
       question_text, payload, confidence, priority, conflict_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    kind,
    dedupKey,
    q.subjectPersonId || null,
    q.objectPersonId || null,
    q.relType || null,
    String(q.questionText || '').trim(),
    JSON.stringify(q.payload || {}),
    Number(q.confidence) || 0,
    Number(q.priority) || 0,
    q.conflictReason || null,
  );
  if (res.changes === 0) {
    const existing = db.prepare('SELECT id FROM relation_questions WHERE dedup_key = ?').get(dedupKey);
    return { id: existing?.id ?? null, inserted: false };
  }
  return { id: Number(res.lastInsertRowid), inserted: true };
}

/**
 * Next open questions by priority (uses idx_rq_open). Deterministic ties
 * break by id so a re-run asks in the same order.
 */
export function nextOpenQuestions(db, limit = 2) {
  return db.prepare(`
    SELECT * FROM relation_questions
    WHERE status = 'open'
    ORDER BY priority DESC, id ASC
    LIMIT ?
  `).all(Math.max(0, Number(limit) || 0));
}

/** Count of questions already surfaced in a conversation (any later status). */
export function askedCountForConversation(db, conversationId) {
  return db.prepare(
    'SELECT COUNT(*) AS n FROM relation_questions WHERE asked_conversation_id = ?',
  ).get(String(conversationId || ''))?.n || 0;
}

/** Mark a question as surfaced in a conversation. */
export function markQuestionAsked(db, id, conversationId) {
  db.prepare(`
    UPDATE relation_questions
       SET status = 'asked', asked_conversation_id = ?, asked_at = datetime('now'),
           updated_at = datetime('now')
     WHERE id = ? AND status = 'open'
  `).run(String(conversationId || ''), id);
  return db.prepare('SELECT * FROM relation_questions WHERE id = ?').get(id);
}

/**
 * The conversation's newest ASKED question — the row a one-word reply is
 * matched against (indexed read; deterministic pre-model lane).
 */
export function latestAskedQuestion(db, conversationId) {
  return db.prepare(`
    SELECT * FROM relation_questions
    WHERE status = 'asked' AND asked_conversation_id = ?
    ORDER BY asked_at DESC, id DESC LIMIT 1
  `).get(String(conversationId || '')) || null;
}

/**
 * Record an answer verdict. Never deletes — declined rows are the permanent
 * never-re-ask record; confirmed rows carry the answer for provenance.
 */
export function recordQuestionAnswer(db, id, { status, answer }) {
  if (!['confirmed', 'declined'].includes(status)) {
    throw new Error(`recordQuestionAnswer: invalid status "${status}"`);
  }
  db.prepare(`
    UPDATE relation_questions
       SET status = ?, answer = ?, answered_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ?
  `).run(status, String(answer || '').trim(), id);
  return db.prepare('SELECT * FROM relation_questions WHERE id = ?').get(id);
}

/** Open-question count (onboarding tile + review-mode copy). */
export function openQuestionCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM relation_questions WHERE status = 'open'").get()?.n || 0;
}
