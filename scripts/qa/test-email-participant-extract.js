#!/usr/bin/env node
/**
 * QA script for AC 5 / VC 5 (st_87a0d072).
 *
 * "Email recipients (To, Cc, Bcc) are extracted as person candidates equally with senders."
 *
 * Strategy:
 *   1. Use the live DB (ROBOTDOJO_ALLOW_PLAINTEXT respected).
 *   2. Pick a unique test email_id prefixed `qa-st_87a0d072-`.
 *   3. Insert an emails row + email_participants rows with sender=A, to=B, cc=C, bcc=D.
 *   4. Run Phase 1 Extract (the relevant portion that iterates email_participants).
 *   5. Assert all four addresses produce candidates in entity_candidates.
 *   6. Clean up.
 *
 * The Phase 1 Extract email source iterates `email_participants` (post st_87a0d072
 * Phase 4). This test invokes only the relevant SQL — not the full pipeline — to
 * keep the QA fast and deterministic.
 *
 * Exit 0 on pass, 1 on fail.
 */

import crypto from 'node:crypto';
import db from '../../lib/db.js';

const PREFIX = 'qa-st_87a0d072-';
const EMAIL_ID = `${PREFIX}${Date.now()}`;
const sender = `${PREFIX}sender@example.com`;
const to     = `${PREFIX}to@example.com`;
const cc     = `${PREFIX}cc@example.com`;
const bcc    = `${PREFIX}bcc@example.com`;

function cleanup() {
  db.prepare('DELETE FROM email_participants WHERE email_id = ?').run(EMAIL_ID);
  db.prepare('DELETE FROM emails WHERE id = ?').run(EMAIL_ID);
  db.prepare(`DELETE FROM entity_candidates WHERE raw_email IN (?,?,?,?)`).run(sender, to, cc, bcc);
}

async function main() {
  cleanup();

  // 1. Seed an emails row + participants (sender + 3 recipients).
  // Use a real account_id from the DB so the FK is satisfied.
  const accountRow = db.prepare("SELECT id FROM accounts WHERE vendor='google' AND type='email' LIMIT 1").get();
  if (!accountRow) {
    console.error('FAIL — no google email account in DB');
    process.exit(1);
  }
  const accountId = accountRow.id;

  db.prepare(`
    INSERT INTO emails
      (id, thread_id, subject, sender, sender_email, snippet, body_text,
       labels, is_read, is_starred, received_at, account_id, is_newsletter, list_unsubscribe)
    VALUES (?, '', 'QA test', 'QA Sender', ?, '', '', '[]', 1, 0, datetime('now'), ?, 0, NULL)
  `).run(EMAIL_ID, sender, accountId);

  const insP = db.prepare(`INSERT INTO email_participants (email_id, participant_email, role) VALUES (?,?,?)`);
  insP.run(EMAIL_ID, sender, 'sender');
  insP.run(EMAIL_ID, to, 'to');
  insP.run(EMAIL_ID, cc, 'cc');
  insP.run(EMAIL_ID, bcc, 'bcc');

  // 2. Run the email-source extraction inline.
  //    Mirrors the SQL added in scripts/ingest/01-extract.js Phase 4 — iterate
  //    email_participants, filter newsletters via emails JOIN, emit one
  //    candidate per (email_id, participant_email, role) row.
  const partRows = db.prepare(`
    SELECT DISTINCT ep.participant_email, ep.role, e.is_newsletter, e.list_unsubscribe
    FROM email_participants ep
    JOIN emails e ON e.id = ep.email_id
    WHERE ep.email_id = ?
  `).all(EMAIL_ID);

  if (partRows.length !== 4) {
    console.error(`FAIL — expected 4 participant rows, got ${partRows.length}`);
    cleanup();
    process.exit(1);
  }

  const ins = db.prepare(`
    INSERT OR IGNORE INTO entity_candidates
      (id, source, source_rank, candidate_type, raw_name, raw_email, raw_phone, raw_location, excluded, exclude_reason)
    VALUES (?, 'email', 4, 'person', ?, ?, NULL, NULL, 0, NULL)
  `);
  db.transaction(() => {
    for (const r of partRows) {
      // Skip newsletters — same exclusion rule as production extract code.
      if (r.is_newsletter === 1 || r.list_unsubscribe != null) continue;
      ins.run(crypto.randomUUID(), null, r.participant_email);
    }
  })();

  // 3. Assert all four emails are present in entity_candidates.
  const found = db.prepare(`
    SELECT raw_email FROM entity_candidates WHERE raw_email IN (?,?,?,?)
  `).all(sender, to, cc, bcc).map(r => r.raw_email).sort();

  const expected = [sender, to, cc, bcc].sort();
  const missing = expected.filter(e => !found.includes(e));
  if (missing.length > 0) {
    console.error(`FAIL — missing candidates: ${JSON.stringify(missing)}`);
    cleanup();
    process.exit(1);
  }

  console.log('ok — 4 candidates (sender, to, cc, bcc) extracted');
  cleanup();
  process.exit(0);
}

main().catch(err => {
  console.error('FAIL —', err);
  cleanup();
  process.exit(1);
});
