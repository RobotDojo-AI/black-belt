/**
 * lib/topic-source-routing.js — deterministic source-account/domain → topic
 * routing for GENERAL content classification (st_56bd10d1).
 *
 * Reuses topicForEmailDomain()'s subdomain-safe domain matcher from
 * lib/asana-routing-config.js against a SEPARATE config
 * (config/source-topic-routing.json + the gitignored owner override
 * config/source-topic-routing.user.json). config/asana-routing.json stays
 * scoped to transcript-derived Asana call-task routing per its own header
 * comment — reusing it here would silently broaden a contract that file and
 * its one consumer (lib/call-routing.js) document narrowly.
 *
 * Deliberately db-free, mirroring lib/asana-routing-config.js: every consumer
 * (lib/chunk-worker.js at initial chunk placement, and
 * scripts/ingest/05-reclassify-chunks.js at the pre-cosine backfill pass)
 * already holds the DB rows it needs (a message's sender_email, the owning
 * account's own email) and passes them in as plain strings.
 *
 * Owner-identifying domains/slugs (the owner's personal domain, a named
 * school) never land in the tracked config/source-topic-routing.json — they
 * live in the gitignored config/source-topic-routing.user.json override,
 * merged at load time, same convention as config/taxonomy.user.json and
 * config/company-aliases.user.json.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { topicForEmailDomain } from './asana-routing-config.js';
import { PERSONAL_TOPIC } from './topic-routing-policy.js';

const DEFAULTS_PATH = new URL('../config/source-topic-routing.json', import.meta.url);

// HOME-resolved (not module-relative) so the override lives in the owner's own
// checkout and is read at runtime — never shipped, never committed
// (config/.gitignore). Env override lets tests point at a fixture without
// touching the real file.
function userOverridePath() {
  return process.env.ROBOTDOJO_SOURCE_TOPIC_ROUTING_USER_PATH
    || resolve(homedir(), 'robotdojo', 'config', 'source-topic-routing.user.json');
}

let _config = null;

/**
 * Load config/source-topic-routing.json merged with the local owner override
 * (when present; user entries win on key collision). Cached per process —
 * same convention as loadAsanaRoutingConfig(): a config change means a new
 * deploy/process, every consumer (chunk worker, reclassify script) runs fresh.
 */
export function loadSourceTopicRoutingConfig() {
  if (_config) return _config;
  const domains = {};
  const base = JSON.parse(readFileSync(DEFAULTS_PATH, 'utf8'));
  Object.assign(domains, base.domains || {});
  const overridePath = userOverridePath();
  if (existsSync(overridePath)) {
    try {
      const override = JSON.parse(readFileSync(overridePath, 'utf8'));
      Object.assign(domains, override.domains || {});
    } catch (err) {
      console.warn(`[topic-source-routing] failed to parse ${overridePath}: ${err.message} — using defaults only`);
    }
  }
  _config = { domains };
  return _config;
}

/** Test-only: force both config files to be re-read on the next call. */
export function _resetSourceTopicRoutingConfigForTests() {
  _config = null;
}

/**
 * Deterministic topic for a piece of source-account content — a
 * HIGH-CONFIDENCE signal that wins over cosine-similarity reclassification
 * (st_56bd10d1).
 *
 * Priority:
 *   0. Explicit mailbox topic (Integrations picker / accounts.topic_slug).
 *      Wins over domain inference when it is not the personal default.
 *   1. The owning MAILBOX account's own domain. When it resolves to anything
 *      OTHER than the personal default, it wins outright — a dedicated
 *      business inbox keeps its own identity even when one message inside it
 *      happens to be from an unrelated configured domain (a cross-org
 *      correspondent, a CC'd contact). The mailbox is the stronger signal
 *      than a single sender.
 *   2. The message's own SENDER domain — checked when the account resolves to
 *      the personal default (or to nothing at all). This is what lets a
 *      configured education-domain sender re-home academic mail landing
 *      inside the general-purpose personal mailbox, without letting an
 *      unrelated free-mail sender (someone emailing a business inbox from a
 *      personal address) drag business correspondence into "personal".
 *   3. Neither matches → null. The caller applies the T1-residual fallback.
 *
 * @param {{ senderEmail?: string, accountEmail?: string, accountTopic?: string }} source
 * @param {object} [config]
 * @returns {string|null} a topic slug, or null when unrouted
 */
export function topicForSourceAccount({ senderEmail, accountEmail, accountTopic } = {}, config = loadSourceTopicRoutingConfig()) {
  const picked = String(accountTopic || '').trim();
  if (picked && picked !== PERSONAL_TOPIC) return picked;
  const mailboxTopic = accountEmail ? topicForEmailDomain(accountEmail, config) : null;
  if (mailboxTopic && mailboxTopic !== PERSONAL_TOPIC) return mailboxTopic;
  const senderTopic = senderEmail ? topicForEmailDomain(senderEmail, config) : null;
  if (senderTopic) return senderTopic;
  return mailboxTopic || null;
}
