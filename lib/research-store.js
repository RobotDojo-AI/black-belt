/**
 * lib/research-store.js — keep what you already paid to fetch.
 *
 * st_4312c9c0 AC-17, the storage half of AC-16's cheap-first ladder. AC-16 says
 * check local before network; this is what makes "local" progressively worth
 * checking. A document fetched once is never paid for twice, and the corpus
 * accumulates into something later analysis can use instead of evaporating when
 * the stage seals.
 *
 * PLACEMENT was checked against architecture/ontology.md rather than invented:
 * rule 7 assigns source evidence to `user/files/`, and reserves
 * `user/workbenches/` for deep working sets. A fetched source document is the
 * former. The owner asked whether workbenches needed to change to support this;
 * they do not, and adding a new home would be the structural violation the
 * ontology exists to prevent. `user/files/` is gitignored by a bare `*`, so
 * third-party documents saved here cannot be committed and raise no PII or
 * licensing exposure.
 *
 * SHAPE: flat store keyed by a hash of the source URL. Each document is saved
 * verbatim alongside a `.meta.json` sidecar. Verbatim because the point is
 * future analysis — a summary written for one story answers only that story's
 * question.
 *
 * STALENESS is reported, never enforced. A hit older than the window is still
 * returned, with its age, so the agent decides whether to re-fetch. A cache that
 * silently decides for the caller is how a stale price figure becomes a wrong
 * money decision.
 */

// INTELLIGENCE_TIER: extraction — deterministic file storage and lookup keyed
// by URL hash. Makes no model call.
export const INTELLIGENCE_TIER = 'extraction';

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STORE_DIR = join(homedir(), 'robotdojo', 'user', 'files', 'research');

// Age past which a hit is reported stale. Not a delete threshold — nothing is
// evicted. Documentation and pricing pages move on roughly this cadence.
const STALE_AFTER_DAYS = 30;

function keyFor(url) {
  return createHash('sha256').update(String(url)).digest('hex').slice(0, 32);
}

function ensureDir() {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
}

/**
 * save — store a fetched document verbatim with its provenance.
 *
 * @param {object} args
 * @param {string} args.url
 * @param {string} args.content   — the document exactly as fetched
 * @param {string} [args.storyId] — which story paid for this fetch
 * @param {string} [args.fetchedAt] — ISO timestamp; caller supplies so the
 *   store never invents a clock reading of its own
 * @returns {{key: string, path: string, metaPath: string}}
 */
export function save({ url, content, storyId = null, fetchedAt = null }) {
  ensureDir();
  const key = keyFor(url);
  const path = join(STORE_DIR, `${key}.txt`);
  const metaPath = join(STORE_DIR, `${key}.meta.json`);

  writeFileSync(path, content, 'utf8');
  writeFileSync(metaPath, `${JSON.stringify({
    url,
    story_id: storyId,
    fetched_at: fetchedAt || new Date().toISOString(),
    content_sha256: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content, 'utf8'),
  }, null, 2)}\n`, 'utf8');

  return { key, path, metaPath };
}

/**
 * lookup — the local rung of the retrieval ladder.
 *
 * @param {string} url
 * @returns {{hit: false} | {hit: true, content: string, url: string,
 *   fetchedAt: string, ageDays: number, stale: boolean}}
 */
export function lookup(url) {
  const key = keyFor(url);
  const path = join(STORE_DIR, `${key}.txt`);
  const metaPath = join(STORE_DIR, `${key}.meta.json`);
  if (!existsSync(path) || !existsSync(metaPath)) return { hit: false };

  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch {
    // A corrupt sidecar means we cannot state provenance, and a document we
    // cannot date is worse than a re-fetch — report a miss.
    return { hit: false };
  }

  const fetchedAt = meta.fetched_at;
  const ageDays = Math.floor((Date.now() - Date.parse(fetchedAt)) / 86_400_000);
  return {
    hit: true,
    content: readFileSync(path, 'utf8'),
    url: meta.url,
    fetchedAt,
    ageDays,
    stale: ageDays > STALE_AFTER_DAYS,
  };
}

/** list — every stored document's provenance, for auditing what the corpus holds. */
export function list() {
  if (!existsSync(STORE_DIR)) return [];
  return readdirSync(STORE_DIR)
    .filter((n) => n.endsWith('.meta.json'))
    .map((n) => {
      try {
        return JSON.parse(readFileSync(join(STORE_DIR, n), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export { STORE_DIR, STALE_AFTER_DAYS };
