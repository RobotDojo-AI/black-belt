// lib/distill-sources/memory-log.js — gather signal from the user's
// hash-chained memory log (user/memory/log by default).
//
// Feedback entries are highest signal (explicit corrections/validations).
// User entries capture identity facts. Project entries provide context on
// active work. Session-notes / references are deprioritized.

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { USER_MEMORY_DIR } from '../robotdojo-paths.js';
import { resolveMemoryLogProvenance, hedgePolicy } from '../provenance.js';

const DEFAULT_PATH = resolve(USER_MEMORY_DIR, 'log');

const PRIORITY = { feedback: 4, user: 3, project: 2, reference: 1, 'session-note': 1 };

// Which cards each memory-log entry type is valid for. Enforces the rule
// that project/user entries don't leak into Soul/Philosophy/Voice — those
// cards are only informed by explicit feedback about AI behavior.
const VALID_CARDS = {
  feedback:        ['identity', 'soul', 'philosophy', 'style', 'user'],
  user:            ['user'],
  project:         ['user'],
  reference:       ['user'],
  'session-note':  ['soul', 'style', 'user'],
};

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return {};
  const lines = content.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end < 0) return {};
  const fm = {};
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/);
    if (m) fm[m[1]] = m[2];
  }
  const body = lines.slice(end + 1).join('\n').trim();
  return { ...fm, body };
}

/**
 * @param {object} [opts]
 * @param {string} [opts.path]        override log dir path
 * @param {number} [opts.maxEntries]  cap by priority
 * @returns {Promise<Array<{ source, timestamp, type, description, name, body }>>}
 */
export async function gather({ path = DEFAULT_PATH, maxEntries = 1000 } = {}) {
  let files;
  try { files = await readdir(path); }
  catch (err) { if (err.code === 'ENOENT') return []; throw err; }

  const logs = files.filter((n) => /^\d{4}-.*\.md$/.test(n));
  const entries = [];
  for (const name of logs) {
    const full = join(path, name);
    const content = await readFile(full, 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm.type) continue;

    // Chunk 7A (revised): this feed is corpus material for wk_user/USER.md
    // distillation (identity-distill.js, generate-user-md.js) and the
    // retrieval index (related-context.js). Provenance is resolved from the
    // BODY (does it attribute a quote to the owner?), not `author` — every
    // entry is authored by an agent process per the memory protocol. An
    // ungrounded entry (source_class llm-distilled/provisional) is the
    // agent's own analysis, never a fact the owner stated —
    // hedgePolicy(sourceClass, undefined) resolves it to 'hedge' (no
    // numeric confidence exists on a memory entry, so it never resolves to
    // 'omit'; see provenance.js hedgePolicy). The marker is baked directly
    // into `description` — the one field every consumer of this feed
    // already prints verbatim — so a provisional note cannot reach a
    // downstream synthesis prompt unmarked regardless of whether that
    // consumer is provenance-aware.
    const { sourceClass, status } = resolveMemoryLogProvenance({ body: fm.body });
    const disposition = hedgePolicy(sourceClass, undefined);
    const rawDescription = fm.description || '';
    const description = disposition === 'hedge' && rawDescription
      ? `${rawDescription} (agent-noted, unconfirmed)`
      : rawDescription;

    entries.push({
      source: `memory-log:${name}`,
      timestamp: fm.timestamp || null,
      type: fm.type,
      description,
      name: fm.name || name,
      body: fm.body || '',
      sourceClass,
      status,
      validCards: VALID_CARDS[fm.type] || [],
      _priority: PRIORITY[fm.type] || 0,
    });
  }
  // Sort: priority desc, then timestamp desc (newer feedback overrides older).
  entries.sort((a, b) => {
    if (a._priority !== b._priority) return b._priority - a._priority;
    return (b.timestamp || '').localeCompare(a.timestamp || '');
  });
  return entries.slice(0, maxEntries).map(({ _priority, ...rest }) => rest);
}
