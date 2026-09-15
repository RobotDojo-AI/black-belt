/**
 * lib/asana-routing-config.js — pure loader for config/asana-routing.json
 * (df_e1dcf732).
 *
 * Deliberately db-free: no import in this module may reach lib/db.js. The
 * config-only consumers (lib/asana.js, lib/followup-sweep.js,
 * scripts/sync-asana.js, scripts/asana-upsert-story.js) import from here so
 * the runtime-writer-safety gate (scripts/check-direct-db-writers.js) only
 * flags entry points that genuinely open the database. The db-backed
 * classifier lives in lib/call-routing.js, which re-exports these functions
 * for its own consumers.
 *
 * The tracked config/asana-routing.json ships a PUBLIC-SAFE default (empty
 * domains/calendars, a placeholder default-workspace, and placeholder
 * board/project/section gids). The owner's real routed domains, work
 * calendar-import id, workspace/project gids, and board/section gids live in the
 * gitignored config/asana-routing.user.json override, deep-merged over the
 * tracked defaults at load — same convention as
 * lib/topic-source-routing.js + config/source-topic-routing.user.json. Owner
 * gids therefore never appear as literals in tracked source (AC9 one-source-of-
 * truth is preserved: they still live in config, just the gitignored half).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// Module-relative (not cwd-relative) so the loader works from any process cwd
// — LaunchAgent sync passes, criteria runs from ~/robotdojo, and worktrees all
// resolve the config that sits next to this checkout's lib/.
const CONFIG_URL = new URL('../config/asana-routing.json', import.meta.url);

// HOME-resolved (not module-relative) so the override lives in the owner's own
// checkout and is read at runtime — never shipped, never committed
// (config/.gitignore). The env override lets tests point at a synthetic fixture
// without touching the real file (mirrors ROBOTDOJO_SOURCE_TOPIC_ROUTING_USER_PATH).
function userOverridePath() {
  return process.env.ROBOTDOJO_ASANA_ROUTING_USER_PATH
    || resolve(homedir(), 'robotdojo', 'config', 'asana-routing.user.json');
}

// Shallow key-merge for the domain/calendar/alias maps: an override entry wins
// on key collision, and new keys are added.
function mergeMap(base, over) {
  return { ...(base || {}), ...(over || {}) };
}

// Per-DESTINATION field merge: each destination row is merged field-by-field so
// the override can supply just one field (e.g. default.workspace) while the
// tracked base supplies the rest (provider/tokenName/label). A destination key
// present only in the override is added whole.
function mergeDestinations(base = {}, over = {}) {
  const out = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(over)])) {
    out[key] = { ...(base[key] || {}), ...(over[key] || {}) };
  }
  return out;
}

// Per-BOARD field merge: like destinations, but each board also carries a nested
// `sections` map that must merge per key (so the override can replace one
// section gid while the tracked base supplies the placeholder for the rest).
// A board present only in the override is added whole. Boards are intentionally
// NOT validated — a fresh clone ships placeholder gids and the consumers
// (lib/asana.js, lib/followup-sweep.js, the sync scripts) degrade gracefully.
function mergeBoards(base = {}, over = {}) {
  const out = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(over)])) {
    const b = base[key] || {};
    const o = over[key] || {};
    out[key] = { ...b, ...o };
    if (b.sections || o.sections) {
      out[key].sections = { ...(b.sections || {}), ...(o.sections || {}) };
    }
  }
  return out;
}

/**
 * True when v is a real, fully-configured Asana gid (a 16-digit numeric string),
 * false for a placeholder (REPLACE_WITH_*), null, or empty. Consumers use this
 * to skip an Asana write on a fresh clone that has not supplied a real board gid
 * — graceful degradation, never a crash.
 */
export function isConfiguredGid(v) {
  return /^\d{16}$/.test(String(v ?? ''));
}

let _config = null;

/**
 * Load config/asana-routing.json, deep-merge the gitignored owner override
 * (when present), then validate the MERGED result. Cached per process — the
 * files are static config; a change means a new deploy, and every consumer
 * (sync pass, remediation script) runs in a fresh process.
 *
 * Validation runs on the merged object (not the tracked file alone) because the
 * tracked default carries only a placeholder workspace: a missing default
 * destination would otherwise route tasks nowhere, which is exactly the silent
 * failure this defect exists to kill. A malformed override that drops the
 * default's tokenName/workspace fails loud here rather than mis-routing.
 */
export function loadAsanaRoutingConfig() {
  if (_config) return _config;
  const base = JSON.parse(readFileSync(CONFIG_URL, 'utf8'));
  let over = {};
  const overridePath = userOverridePath();
  if (existsSync(overridePath)) {
    try {
      over = JSON.parse(readFileSync(overridePath, 'utf8'));
    } catch (err) {
      console.warn(`[asana-routing-config] failed to parse ${overridePath}: ${err.message} — using tracked defaults only`);
      over = {};
    }
  }
  const merged = {
    ...base,
    domains: mergeMap(base.domains, over.domains),
    calendars: mergeMap(base.calendars, over.calendars),
    topicAliases: mergeMap(base.topicAliases, over.topicAliases),
    destinations: mergeDestinations(base.destinations, over.destinations),
    boards: mergeBoards(base.boards, over.boards),
  };
  if (!merged?.destinations?.default?.workspace || !merged?.destinations?.default?.tokenName) {
    throw new Error('asana-routing config (merged): destinations.default needs workspace and tokenName');
  }
  for (const [key, dest] of Object.entries(merged.destinations)) {
    if (!dest?.workspace || !dest?.tokenName || !dest?.provider) {
      throw new Error(`asana-routing config (merged): destination "${key}" needs provider, tokenName, workspace`);
    }
  }
  _config = merged;
  return _config;
}

/** Test-only: force both config files to be re-read on the next call. */
export function _resetAsanaRoutingConfigForTests() {
  _config = null;
}

/**
 * The set of "primary work" topic slugs — every destination key that routes to a
 * dedicated (non-default) Asana workspace. Derived from config, never hardcoded:
 * the owner's employer slug lives in the gitignored asana-routing.user.json
 * override, so a fresh clone with only the tracked `default` destination returns
 * an empty set.
 *
 * These slugs win top precedence in transcript folder-membership resolution
 * (lib/granola-client.js): a call cross-filed into a primary-work folder plus any
 * other folder routes to the primary-work topic, because a work call belongs on
 * the work board. On a fresh clone the empty set makes that precedence rule a
 * no-op — folder resolution falls through to the generic single-slug / personal
 * tiebreak with no employer slug baked into product code.
 */
export function primaryWorkTopicSlugs(config = loadAsanaRoutingConfig()) {
  return new Set(Object.keys(config.destinations || {}).filter((k) => k !== 'default'));
}

/** Normalize any topic/tag spelling to a comparable slug (e.g. "Work Client" → "work-client"). */
export function normalizeTopicSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolve a topic to its destination key: alias-normalized slug when a
 * destination exists for it, else 'default'. Every non-routed topic
 * (personal, networking, uncategorized, unknown) lands on 'default' — the
 * primary workspace — by construction.
 */
export function destinationKeyForTopic(topic, config = loadAsanaRoutingConfig()) {
  const slug = normalizeTopicSlug(topic);
  const resolved = config.topicAliases?.[slug] || slug;
  return config.destinations[resolved] ? resolved : 'default';
}

/** The Asana destination row ({provider, tokenName, workspace, project, label}) for a topic. */
export function asanaDestinationForTopic(topic, config = loadAsanaRoutingConfig()) {
  return config.destinations[destinationKeyForTopic(topic, config)];
}

/** Topic slug for an email's domain per config.domains — exact or subdomain match; null when unrouted. */
export function topicForEmailDomain(email, config = loadAsanaRoutingConfig()) {
  const domain = String(email || '').toLowerCase().split('@')[1] || '';
  if (!domain) return null;
  for (const [routedDomain, slug] of Object.entries(config.domains || {})) {
    if (domain === routedDomain || domain.endsWith(`.${routedDomain}`)) return slug;
  }
  return null;
}

/**
 * Topic slug for a calendar_id per config.calendars (df_33f550b7). EXACT-id
 * allowlist — a subscribed/import calendar that strips attendees carries no
 * domain signal, so its own calendar identity is the deterministic route. A
 * pattern/suffix match would sweep the owner's other-venture import calendar
 * and misroute its calls; this is `===` on the exact id only. Null when the id
 * is absent or unmapped. Pure, db-free (mirrors topicForEmailDomain).
 */
export function topicForCalendarId(calendarId, config = loadAsanaRoutingConfig()) {
  const id = String(calendarId || '').toLowerCase();
  if (!id) return null;
  return config.calendars?.[id] || null;
}
