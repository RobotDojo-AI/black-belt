/**
 * Phase 2c — iMessage (link only — participants may be names or phones).
 */
import db from '../../lib/db.js';
import { getBBModule } from '../../lib/module-loader.js';

const wbNormalizeEmail = (s) => (typeof s === 'string' ? s.toLowerCase().trim() : null);
const wbNormalizePhone = (s) => {
  if (!s) return null;
  const digits = String(s).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return digits.length >= 7 ? `+${digits}` : null;
};
function wbLinkPerson({ email, phone }) {
  if (email) {
    const e = email.toLowerCase().trim();
    return db.prepare('SELECT person_id as id FROM person_identifiers WHERE type=? AND value=? LIMIT 1').get('email', e) || null;
  }
  if (phone) {
    return db.prepare('SELECT person_id as id FROM person_identifiers WHERE type=? AND value=? LIMIT 1').get('phone', phone) || null;
  }
  return null;
}

function getBB() { return getBBModule(); }

export function phaseIMessage(log) {
  const bb = getBB();
  const normalizeEmail = bb?.normalizeEmail ?? wbNormalizeEmail;
  const normalizePhone = bb?.normalizePhone ?? wbNormalizePhone;
  const linkPerson = bb?.linkPerson ?? wbLinkPerson;
  log('\n=== Phase 2c: iMessage (link only) ===');
  const rows = db.prepare(`
    SELECT DISTINCT json_extract(metadata, '$.participant') as participant
    FROM chunks WHERE source_type = 'imessage' AND metadata IS NOT NULL
  `).all();

  const stats = { total: rows.length, linked_by_email: 0, linked_by_name: 0 };
  for (const row of rows) {
    const raw = row.participant;
    if (!raw) continue;
    const trimmed = String(raw).trim();
    if (trimmed === 'Group Chat' || trimmed.length < 2) continue;

    // Try email first
    const asEmail = normalizeEmail(trimmed);
    if (asEmail?.includes('@')) {
      if (linkPerson({ email: asEmail, source: 'imessage' })) { stats.linked_by_email++; continue; }
    }

    // Try phone (E.164)
    const asPhone = normalizePhone(trimmed);
    if (asPhone) {
      if (linkPerson({ phone: asPhone, source: 'imessage' })) { stats.linked_by_email++; continue; }
    }

    // Name match: look up by exact display_name (case-insensitive)
    const match = db.prepare(
      'SELECT id FROM people WHERE LOWER(display_name) = LOWER(?) AND archived = 0 LIMIT 1'
    ).get(trimmed);
    if (match) {
      // Record the link under imessage source (no new person)
      stats.linked_by_name++;
    }
  }
  log(`  ${stats.total} participants: ${stats.linked_by_email} by email/phone, ${stats.linked_by_name} by name`);
  return stats;
}
