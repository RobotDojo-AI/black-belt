/**
 * Person professional context — White Belt stubs.
 *
 * Black Belt enrichment lives behind the cohort entitlement gate.
 * In White Belt, signal functions return 0 (neutral) so referral
 * scoring still runs but without professional-signal enrichment.
 *
 * getPersonProfessional() reads from the person_professional table when
 * rows exist (from prior BB enrichment); returns null otherwise.
 */
import db from './db.js';

export function getPersonProfessional(personId) {
  try {
    return db.prepare('SELECT * FROM person_professional WHERE person_id = ? LIMIT 1').get(personId) ?? null;
  } catch { return null; }
}

export async function extractBatch() {
  return { extracted: 0, domainOnly: 0, skipped: 0, costUsd: 0 };
}

export function technicalSignal()     { return 0; }
export function privacyDomainSignal() { return 0; }
export function privacyKeywordSignal(){ return 0; }
export function sharingSignal()       { return 0; }

export const _domains = {
  TECH_DOMAINS: new Set(),
  PERSONAL_DOMAINS: new Set(),
  PRIVACY_DOMAINS: new Set(),
};
