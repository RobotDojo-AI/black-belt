// lib/distill-sources/email.js — sample the user's own outbound emails for
// USER-FACT signal (projects, people, timeline).
//
// Sent mail IS owner-to-world writing. The owner-voice learner reads SENT
// separately. This module does not mine email for Miyagi. Chat logs and
// working-together feedback train Miyagi. How the owner types to the agent
// is not owner voice.
//
// Filter:
//   - Gmail SENT label (reliable)
//   - Last 3 years only (older is noise)
//   - Optional sender-email allowlist (defaults to any sent-labeled row)

import db from '../db.js';

const MIN_BODY_CHARS = 100;
const MAX_BODY_CHARS = 2000;
const DEFAULT_SINCE_YEARS = 3;

export async function gather({
  limit = 150,
  sinceIso = null,
  sinceYears = DEFAULT_SINCE_YEARS,
  senderEmails = null,
} = {}) {
  const since = sinceIso || new Date(Date.now() - sinceYears * 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const params = [MIN_BODY_CHARS, since];
  let senderClause = '';
  if (senderEmails && senderEmails.length) {
    senderClause = ` AND sender_email IN (${senderEmails.map(() => '?').join(',')})`;
    params.push(...senderEmails);
  }
  params.push(limit);

  const rows = db.prepare(`
    SELECT id, subject, body_text, received_at, sender_email
    FROM emails
    WHERE labels LIKE '%"SENT"%'
      AND body_text IS NOT NULL
      AND length(body_text) >= ?
      AND received_at >= ?
      ${senderClause}
    ORDER BY received_at DESC
    LIMIT ?
  `).all(...params);

  return rows.map((r) => ({
    source: `email:sent:${r.id}`,
    timestamp: r.received_at,
    type: 'sent-email',
    description: `${r.sender_email || ''} — ${r.subject || '(no subject)'}`.trim(),
    body: (r.body_text || '').slice(0, MAX_BODY_CHARS),
    // User-card facts only. Owner voice reads SENT via writing-learn.
    validCards: ['user'],
  }));
}
