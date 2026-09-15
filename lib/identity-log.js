// lib/identity-log.js — typed helpers over memory.js for identity sections.
//
// Identity is the 5 default cards (identity, soul, philosophy, user, voice)
// plus any custom cards the user creates. Each card is one "section." A
// section update is appended as a type=identity entry; latest-wins projection
// gives the current state. Full history for a section is available by
// filtering the log.

import { appendMemory, getLogIndex, readEntryBody } from './memory.js';

export const DEFAULT_SECTIONS = ['identity', 'soul', 'philosophy', 'user', 'style'];

export const SECTION_LABELS = {
  identity: 'Identity',
  soul: 'Soul',
  philosophy: 'Philosophy',
  user: 'User',
  style: 'Style',
};

// Back-compat: log entries with `section: voice` are projected under `style`.
// "Voice" was the original name; renamed 2026-04-19 to avoid collision with
// the Black Belt BB.2 voice-drafting product (user→human, per-relationship).
// Old entries stay in the chain for audit; projection merges them under the
// new name via this alias table.
export const SECTION_ALIASES = {
  voice: 'style',
};

function canonical(section) {
  return SECTION_ALIASES[section] || section;
}

const SECTION_RE = /^[a-z0-9][a-z0-9-]*$/;

function nameFor(section) {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `${section}-${stamp}-${rnd}`;
}

/**
 * Append an identity section update. Full replacement of the section body
 * (not a diff). Latest entry per section wins in the projection.
 *
 * @param {object} opts
 * @param {string} opts.section    e.g. 'soul', 'voice', or a user-defined name
 * @param {string} opts.body       markdown body (full replacement)
 * @param {string} [opts.description]
 * @param {string} [opts.author]   defaults to 'chat'
 * @param {string} [opts.sessionId]
 * @param {string[]} [opts.tags]
 */
export async function appendIdentitySection({
  section, body, description, author = 'chat', sessionId = null, tags = null,
}) {
  if (!section || !SECTION_RE.test(section)) {
    throw new Error(`identity section must be kebab-case: "${section}"`);
  }
  if (body === undefined || body === null) {
    throw new Error('appendIdentitySection: body is required (use empty string to clear)');
  }
  return appendMemory({
    type: 'identity',
    name: nameFor(section),
    section,
    description: description || `Update to ${section}`,
    author,
    body,
    sessionId,
    tags,
  });
}

/**
 * Current state of every identity section. Latest-wins per section.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.defaults]  default section list to backfill empties
 * @returns {Promise<{ sections: Record<string, { body, updatedAt, author, sourceName, description }>, order: string[] }>}
 */
export async function currentSnapshot({ defaults = DEFAULT_SECTIONS } = {}) {
  const index = await getLogIndex();
  const identityEntries = index.filter((e) => e.type === 'identity' && e.section);

  const sections = {};
  // Index is sorted newest-first, so first occurrence per section wins.
  // Aliases fold old section names into new ones at projection time.
  for (const entry of identityEntries) {
    const key = canonical(entry.section);
    if (sections[key]) continue;
    const body = await readEntryBody(entry.path);
    sections[key] = {
      body,
      updatedAt: entry.timestamp,
      author: entry.author,
      sourceName: entry.name,
      description: entry.description,
      originalSection: entry.section !== key ? entry.section : undefined,
    };
  }

  // Backfill defaults so consumers can rely on them always being keys.
  for (const s of defaults) {
    if (!sections[s]) {
      sections[s] = { body: '', updatedAt: null, author: null, sourceName: null, description: '' };
    }
  }

  const customSections = Object.keys(sections).filter((s) => !defaults.includes(s)).sort();
  const order = [...defaults, ...customSections];
  return { sections, order };
}

/**
 * Full history for a single section, newest first.
 */
export async function sectionHistory(section) {
  const index = await getLogIndex();
  return index.filter((e) => e.type === 'identity' && e.section === section);
}

/**
 * Returns true if the log contains no identity entries yet. Used by seeders
 * and onboarding to decide whether to apply default content.
 */
export async function isEmpty() {
  const index = await getLogIndex();
  return !index.some((e) => e.type === 'identity');
}
