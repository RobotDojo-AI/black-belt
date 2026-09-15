/**
 * lib/call-routing.js — deterministic Asana call-task routing (df_e1dcf732).
 *
 * One classifier, two consumers: the live sync path (lib/granola-sync.js)
 * stamps transcripts.topic through resolveCallTopic, and one-shot remediation
 * tooling partitions historical rows through classifyCallOwnership. A single
 * implementation is the drift guard — two would diverge silently.
 *
 * Routing is layered and Tier 0 throughout (no LLM anywhere — ownership is
 * an identity decision, and identity decisions never go to an LLM):
 *   1. Granola folder mark — only when the feed discriminates (the broken-feed
 *      guard in lib/granola-client.js discards a map where every routed list
 *      returns the identical doc set).
 *   2. Calendar-invite domain — ≥1 attendee at a routed domain (subdomains
 *      included) whose address is not the owner's.
 *   3. personal — the explicit no-signal default (owner's rule), including
 *      calls where the owner's own routed-domain address is the only one
 *      present.
 *
 * All workspace/project gids and routed domains live in
 * config/asana-routing.json — never as literals in code (AC9, one source of
 * truth). Thin-facade: db is always injected as the first argument.
 *
 * The pure config loader lives in lib/asana-routing-config.js (db-free by
 * contract, so config-only consumers stay off the direct-db-writers radar);
 * it is re-exported here so classifier consumers keep a single import.
 */

import { resolveRoster } from './transcript-roster.js';
import { ownerEmails, ownerPersonId } from './identity.js';
import { PERSONAL_TOPIC } from './topic-routing-policy.js';
import {
  loadAsanaRoutingConfig,
  normalizeTopicSlug,
  destinationKeyForTopic,
  asanaDestinationForTopic,
  topicForEmailDomain,
  topicForCalendarId,
} from './asana-routing-config.js';

export {
  loadAsanaRoutingConfig,
  normalizeTopicSlug,
  destinationKeyForTopic,
  asanaDestinationForTopic,
};

/**
 * Deterministic ownership classifier — the calendar layer of the routing rule.
 *
 * Calendar join runs in the verified order via resolveRoster
 * (lib/transcript-roster.js): calendar_event_id → ical_uid → deterministic
 * time-window tier → attendee_emails CSV as last resort. From the resulting
 * roster:
 *   - ≥1 non-owner attendee at a routed domain      → that domain's topic slug
 *   - owner attended under a routed-domain identity
 *     AND ≥1 other (non-owner) attendee is present  → that domain's topic slug
 *   - a calendar event matched, no routed evidence  → 'personal'
 *   - no deterministic evidence at all              → null (never guessed)
 *
 * WHY the owner-routed-identity rule (build finding, df_e1dcf732): the live
 * corpus carries genuinely work calls — vendor negotiations, executive
 * recruiting — whose invites hold the owner's own work-account address plus
 * external counterparties and no work colleague. Research's verified partition
 * counts them as work; the deterministic signal is the owner attending under the
 * work calendar identity in a multi-party call. The owner's routed address ALONE
 * (no other attendee) still classifies personal — that is the owner's stated
 * rule in AC1, preserved exactly.
 *
 * Owner detection is two-layered because resolveRoster behaves differently on
 * each: an owner address that matchPerson resolves stays in the roster as a
 * candidate with the owner's personId, while an unresolved owner address is
 * dropped inside resolveRoster via the ownerEmails() set — which therefore
 * MUST contain the owner's routed-domain address (identity config, not a
 * routing-rule special case; see plan decision 3).
 *
 * @param {import('better-sqlite3').Database} database
 * @param {object} row — transcript-shaped: {id, title, meeting_date,
 *   calendar_event_id, ical_uid, attendee_emails, topic?}
 * @returns {'personal'|string|null} a routed work-topic slug, 'personal', or null
 */
export function classifyCallOwnership(database, row, config = loadAsanaRoutingConfig()) {
  const owners = new Set(ownerEmails());
  const ownerId = ownerPersonId();
  const { candidates, matchedEventCount, directCalendarId } = resolveRoster(database, row);
  let ownerRoutedSlug = null;
  let nonOwnerCount = 0;
  for (const candidate of candidates) {
    const email = String(candidate.email || '').toLowerCase();
    if (!email) continue; // title-derived candidates carry no domain evidence
    const slug = topicForEmailDomain(email, config);
    const isOwner = owners.has(email) || (ownerId && candidate.personId === ownerId);
    if (isOwner) {
      if (slug) ownerRoutedSlug = slug; // owner attended under a routed identity
      continue; // never direct evidence on its own
    }
    nonOwnerCount++;
    if (slug) return slug; // strongest evidence: a non-owner at the routed domain
  }
  if (ownerRoutedSlug && nonOwnerCount > 0) return ownerRoutedSlug;
  // df_33f550b7 — calendar-ownership layer. An import/subscribed calendar (e.g.
  // the owner's work calendar) strips attendees, so no domain signal
  // exists above, yet the transcript's OWN embedded event belongs to a known
  // routed calendar. directCalendarId is read (transcript-roster) by a dedicated
  // UNFILTERED lookup on the transcript's own event_id/ical_uid only — never a
  // time-window candidate — so this cannot misroute a personal call that merely
  // sits near an import event. Placed AFTER the attendee-domain checks (a routed
  // attendee always wins) and BEFORE both personal fallbacks, so it intercepts
  // BOTH misroute paths: the null→PERSONAL default and the matchedEventCount>0→
  // personal return. Exact-id allowlist, Tier 0 (no LLM).
  const calSlug = topicForCalendarId(directCalendarId, config);
  if (calSlug) return calSlug;
  // A calendar event matched and carried no routed evidence: positive
  // evidence the call is not a routed-workspace call.
  if (matchedEventCount > 0) return PERSONAL_TOPIC;
  // No event matched and the CSV held no routed address: no deterministic
  // evidence. Callers decide the default; the classifier never guesses.
  return null;
}

/**
 * Sync-time topic stamp — the full layered rule.
 * Folder slug when the guarded membership map has one (the map is empty while
 * Granola's feed is broken, so this layer self-disarms and self-resumes);
 * else the calendar classifier; else 'personal' (AC1's explicit no-signal
 * default — the old 'uncategorized' fallback drops out of this path).
 */
export function resolveCallTopic(database, row, folderSlug = null, config = loadAsanaRoutingConfig()) {
  if (folderSlug) {
    const slug = normalizeTopicSlug(folderSlug);
    return config.topicAliases?.[slug] || slug;
  }
  return classifyCallOwnership(database, row, config) ?? PERSONAL_TOPIC;
}
