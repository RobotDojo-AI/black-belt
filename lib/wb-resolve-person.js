/**
 * lib/wb-resolve-person.js — the shared White-Belt-fallback person resolver
 * (st_180aa017 AC-4). Reconciles the three near-identical `wbResolvePerson`
 * copies that had already drifted (scripts/rebuild/phase-02-contacts.js,
 * scripts/rebuild/phase-03-calendar.js, scripts/onboard.js) into one
 * drift-free helper — behavior-preserving extraction, not a rewrite.
 *
 * `db` is INJECTED as the first argument (build-conventions thin-facade: deps
 * as arguments, no implicit module singleton) so this helper is unit-testable
 * against an in-memory DB and each call site keeps resolving against its own
 * `db` import.
 *
 * Return shape is the SUPERSET of the three diverged shapes:
 * `{ id, personId, created }` with `personId` always === `id`.
 * phase-02-contacts.js already read `r.personId` for the family-relation-
 * tagging path (setRelationTag); the other two copies only ever read
 * `r.id`/`r.created` — additive, so no existing caller loses a key.
 *
 * Each call site preserves its OWN pre-existing BB-swap gate as-is — this file
 * only replaces the local fallback BODY, never the gate that decides whether
 * the fallback runs at all:
 *   - phase-02-contacts.js / phase-03-calendar.js keep
 *     `getBBModule()?.resolvePerson ?? ((c) => wbResolvePerson(db, c))`.
 *   - onboard.js keeps its DISTINCT `isBBActive()`-based gate
 *     `bbApi?.resolvePerson ?? ((c) => wbResolvePerson(db, c))` — never
 *     `getBBModule()`, whose module cache is never populated in that
 *     standalone CLI (switching would silently drop BB entitlement to the WB
 *     fallback).
 */
import { randomBytes } from 'node:crypto';
import { classifyEmailAddress } from './identity-matching.js';
import { writeEmailClassificationReview } from './people-merge.js';

/**
 * WB fallback (BB inactive): SQL-only resolve, routed through the SHARED email
 * classifier so a role/generic email can never seed or attach a person via this
 * degraded path. 'role' -> drop the email (person may still be created by
 * name); 'uncertain' -> attach but flag for the offline adjudication tier;
 * 'person' -> normal attach.
 *
 * `phone` is accepted for candidate-shape parity with the BB resolvePerson
 * signature (`{ name, email, phone, source }`) but is not used by the WB path
 * — unchanged from all three original copies, none of which read it either.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{name?:string, email?:string, phone?:string, source?:string}} candidate
 * @returns {{id:string|null, personId:string|null, created:boolean}}
 */
export function wbResolvePerson(db, { name, email, phone, source } = {}) {
  const raw = email?.toLowerCase().trim() || null;
  const verdict = raw ? classifyEmailAddress(raw) : null;
  const normEmail = verdict === 'role' ? null : raw; // a role email is never a person identifier
  const existing = normEmail
    ? db.prepare('SELECT person_id as id FROM person_identifiers WHERE type=? AND value=? LIMIT 1').get('email', normEmail)
    : null;
  if (existing) return { id: existing.id, personId: existing.id, created: false };
  if (!normEmail && !name) return { id: null, personId: null, created: false }; // no handle, no name -> nothing to anchor
  const id = `p_${Date.now()}_${randomBytes(3).toString('hex')}`;
  db.prepare('INSERT OR IGNORE INTO people (id, display_name, source_count) VALUES (?, ?, 1)').run(id, name || normEmail || 'Unknown');
  if (normEmail) {
    db.prepare('INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source) VALUES (?, ?, ?, ?)').run(id, 'email', normEmail, source || 'unknown');
    if (verdict === 'uncertain') writeEmailClassificationReview(db, id, normEmail, { reason: 'uncertain-email', source: source || 'wb-fallback' });
  }
  return { id, personId: id, created: true };
}
