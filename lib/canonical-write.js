// lib/canonical-write.js — st_a78848a0 (canonical-surface integrity ratchet).
//
// Substrate: canonical_versions table (Viget-style hash chain) + the
// canonical_versions_quarantine sibling for rejected candidates. Every
// classified canonical surface gets a chained version history; every write
// passes through a deterministic scorer that can disallow (AbuseFilter-style
// bulk-loss, structural-diff regression, or marker tampering), warn (soft
// shrink between 25-50%), or accept.
//
// Mutex model (D1, hybrid):
//   - Module-level _writeQueue promise chain serializes same-process writes
//     (mirrors lib/memory.js:_appendQueue).
//   - SQLite BEGIN IMMEDIATE wraps the INSERT to serialize cross-process.
//
// All public entrypoints RETURN rather than throw — canonical doc callers may
// run inside a batch, and a throw would skip the rest of the batch. The
// rejection envelope is {accepted: false, reason: '<enum>'}.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, isAbsolute, dirname } from 'node:path';
import db from './db.js';

// The old LLM scoring layer was removed under st_5285c160 (canonical-doc-hybrid).
// Under hand-curated governance every commit goes through owner review + the
// pre-commit chain instead. Callers that route through canonicalWrite still get
// the deterministic scorer (size/structural/marker rules) + the version chain.

const REPO_ROOT = resolve(homedir(), 'robotdojo');
const SURFACES_PATH = process.env.ROBOTDOJO_SURFACES_PATH
  || resolve(REPO_ROOT, 'architecture/surfaces.json');

// ─── Scorer constants ────────────────────────────────────────────────────────
// Centralized so adding/tweaking a rule is one line. The thresholds match
// the AbuseFilter rule from Wikipedia (50% bulk-loss disallow, 25% soft warn).
const SHRINK_DISALLOW_RATIO = 0.50; // ≥50% shrinkage → disallow
const SHRINK_WARN_RATIO = 0.25;     // ≥25%, <50% shrinkage → warn
const SHRINK_ABSOLUTE_FLOOR = -500; // edit_delta beyond this triggers absolute rule
const COSINE_WARN_THRESHOLD = 0.70; // < this → warn
const COSINE_DISALLOW_THRESHOLD = 0.50; // < this → disallow
const HUMAN_MARKER_RE = /^<!-- HUMAN-AUTHORED\. REGEN BLOCKED\. -->\s*$/m;

// ─── Serialization ───────────────────────────────────────────────────────────
let _writeQueue = Promise.resolve();

function _enqueue(fn) {
  const next = _writeQueue.then(fn);
  _writeQueue = next.catch(() => {});
  return next;
}

// ─── Path helpers ────────────────────────────────────────────────────────────
export function expandPath(p) {
  if (!p) return p;
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  if (p === '~') return homedir();
  if (isAbsolute(p)) return p;
  return resolve(REPO_ROOT, p);
}

// Normalized doc_path key — the form stored in canonical_versions and looked
// up in canonical-surfaces.json. Same logical file via different forms
// (relative vs ~/...) must collapse to the same key.
export function canonicalKey(p) {
  const abs = expandPath(p);
  if (abs.startsWith(REPO_ROOT + '/')) return abs.slice(REPO_ROOT.length + 1);
  if (abs === REPO_ROOT) return '.';
  if (abs.startsWith(homedir() + '/')) return '~/' + abs.slice(homedir().length + 1);
  return abs;
}

export function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex');
}

// ─── canonical-surfaces.json cache ───────────────────────────────────────────
// Per-process, mtime-invalidated. /promote-style workflows that mutate
// canonical-surfaces.json take effect without restart.
let _surfacesCache = { mtime: 0, byKey: new Map() };

function _loadSurfaces() {
  let mtime;
  try { mtime = statSync(SURFACES_PATH).mtimeMs; }
  catch (err) {
    if (err.code === 'ENOENT') { _surfacesCache = { mtime: 0, byKey: new Map() }; return; }
    throw err;
  }
  if (mtime === _surfacesCache.mtime) return;

  const raw = readFileSync(SURFACES_PATH, 'utf8');
  const data = JSON.parse(raw);
  const byKey = new Map();
  for (const s of data.surfaces || []) {
    // last entry wins — append-only audit trail.
    byKey.set(canonicalKey(s.path), s);
  }
  _surfacesCache = { mtime, byKey };
}

export function canonicalClass(path) {
  if (!path) return null;
  _loadSurfaces();
  const entry = _surfacesCache.byKey.get(canonicalKey(path));
  return entry ? entry.class : null;
}

export function canonicalSurface(path) {
  if (!path) return null;
  _loadSurfaces();
  return _surfacesCache.byKey.get(canonicalKey(path)) || null;
}

// ─── Header set extraction ───────────────────────────────────────────────────
// Pulls ^## and ^### headers for structural-diff comparison. Headers are
// trimmed and lowercased so cosmetic whitespace edits don't trigger.
function extractHeaders(content) {
  const set = new Set();
  for (const line of content.split('\n')) {
    const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (m) set.add(`${m[1]} ${m[2].trim().toLowerCase()}`);
  }
  return set;
}

// ─── Quality scorer ──────────────────────────────────────────────────────────
// Pure function. No DB, no LLM, no I/O. Embedding cosine is fetched separately
// (it's async + network) and passed in as an option for testability.

export function scoreCandidate(priorContent, candidateContent, opts = {}) {
  const {
    class: klass = 'programmatically-generated',
    allowShrink = false,
    size_floor = null,
    embeddingCosine = null,
  } = opts;

  const priorSize = Buffer.byteLength(priorContent, 'utf8');
  const candidateSize = Buffer.byteLength(candidateContent, 'utf8');
  const lengthDelta = candidateSize - priorSize;
  const shrinkRatio = priorSize > 0 ? (priorSize - candidateSize) / priorSize : 0;

  const priorHeaders = extractHeaders(priorContent);
  const newHeaders = extractHeaders(candidateContent);
  const removed = [...priorHeaders].filter(h => !newHeaders.has(h));
  const added = [...newHeaders].filter(h => !priorHeaders.has(h));
  const structuralDiffOk = removed.length === 0;

  const reasons = [];
  let decision = 'accept';
  let rejection_reason = null;

  // Rule 1: marker preserved (human-authored only)
  if (klass === 'human-authored') {
    if (!HUMAN_MARKER_RE.test(candidateContent)) {
      decision = 'disallow';
      rejection_reason = 'marker-tampered';
      reasons.push('marker-missing');
    }
  }

  // Rule 2: bulk-loss disallow (AbuseFilter)
  if (decision !== 'disallow' && !allowShrink) {
    const belowFloor = size_floor != null && priorSize < size_floor;
    if (!belowFloor && shrinkRatio > SHRINK_DISALLOW_RATIO) {
      decision = 'disallow';
      rejection_reason = 'size-delta-disallow';
      reasons.push(`shrink-${Math.round(shrinkRatio * 100)}pct`);
    }
  }

  // Rule 3: absolute-loss disallow — small files where 50% < 500 bytes
  if (decision !== 'disallow' && !allowShrink) {
    if (lengthDelta < SHRINK_ABSOLUTE_FLOOR && shrinkRatio > SHRINK_WARN_RATIO) {
      decision = 'disallow';
      rejection_reason = 'size-delta-disallow';
      reasons.push(`absolute-loss-${lengthDelta}b`);
    }
  }

  // Rule 4: structural-diff disallow
  if (decision !== 'disallow' && !allowShrink) {
    if (!structuralDiffOk) {
      decision = 'disallow';
      rejection_reason = 'structural-diff-disallow';
      reasons.push(`lost-headers-${removed.length}`);
    }
  }

  // Rule 5: embedding cosine — soft warn, escalate to disallow below 0.50
  if (decision !== 'disallow' && embeddingCosine != null) {
    if (embeddingCosine < COSINE_DISALLOW_THRESHOLD) {
      decision = 'disallow';
      rejection_reason = 'embedding-cosine-disallow';
      reasons.push(`cosine-${embeddingCosine.toFixed(3)}`);
    } else if (embeddingCosine < COSINE_WARN_THRESHOLD) {
      if (decision === 'accept') decision = 'warn';
      reasons.push(`low-cosine-${embeddingCosine.toFixed(3)}`);
    }
  }

  // Rule 6: size-delta warn (soft tier)
  if (decision === 'accept' && shrinkRatio > SHRINK_WARN_RATIO && shrinkRatio <= SHRINK_DISALLOW_RATIO) {
    decision = 'warn';
    reasons.push(`shrink-warn-${Math.round(shrinkRatio * 100)}pct`);
  }

  return {
    lengthDelta,
    shrinkRatio,
    structuralDiffOk,
    embeddingCosine,
    sectionDiff: { added, removed, kept: [...priorHeaders].filter(h => newHeaders.has(h)) },
    decision,
    reasons,
    rejection_reason,
  };
}

// ─── Embedding helper (optional — falls back to null on failure) ─────────────
// Imported lazily so tests don't pull in the embedding network surface and
// so a missing key doesn't block the gate from running.
async function _maybeEmbedCosine(prior, candidate) {
  if (process.env.ROBOTDOJO_SKIP_EMBED_SCORE === '1') return null;
  try {
    const { embed, cosineSimilarity } = await import('./rag.js');
    // Truncate to ~5K chars each (embedding API has token limits).
    const a = await embed(prior.slice(0, 5000));
    const b = await embed(candidate.slice(0, 5000));
    return cosineSimilarity(a, b);
  } catch (err) {
    // Network down, key missing, rate-limited — fall back to skip.
    process.stderr.write(`[canonical-write] embedding skipped: ${err.message}\n`);
    return null;
  }
}

// ─── canonicalGenesis ────────────────────────────────────────────────────────
// First row in the chain. prev_sha256 = NULL, score_json = NULL. Does not
// write the file — callers pass already-on-disk content for the seed case.

export function canonicalGenesis(path, content, source, classOverrideOrOpts = null) {
  // Backward-compat: classOverride was previously a positional string. We now
  // accept either a string (legacy) or an opts object {classOverride, skipJudge}.
  const opts = (typeof classOverrideOrOpts === 'string' || classOverrideOrOpts === null)
    ? { classOverride: classOverrideOrOpts, skipJudge: false }
    : { classOverride: null, skipJudge: false, ...classOverrideOrOpts };

  return _enqueue(async () => {
    if (!path || typeof path !== 'string') return { ok: false, reason: 'invalid-path' };
    if (typeof content !== 'string') return { ok: false, reason: 'invalid-content' };
    if (!source) return { ok: false, reason: 'missing-source' };

    const key = canonicalKey(path);
    const sha = sha256Hex(content);
    const size = Buffer.byteLength(content, 'utf8');

    const klass = opts.classOverride || canonicalClass(path);
    if (!klass) return { ok: false, reason: 'unclassified-surface' };

    const existing = db.prepare(
      'SELECT 1 FROM canonical_versions WHERE doc_path = ? AND prev_sha256 IS NULL LIMIT 1',
    ).get(key);
    if (existing) return { ok: false, reason: 'genesis-exists' };

    // Genesis LLM scoring was removed under st_5285c160 (canonical-doc-hybrid).
    // Under the hand-curated regime, owner review at commit time is the floor.
    let qualityJson = null;

    try {
      const insert = db.prepare(`
        INSERT INTO canonical_versions
          (doc_path, content_sha256, prev_sha256, content_size, regen_source, class, score_json, quality_json, story_id)
        VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?)
      `);
      const tx = db.transaction((args) => insert.run(...args));
      tx([key, sha, size, source, klass, qualityJson, process.env.STORY_ID || null]);
      return { ok: true, sha };
    } catch (err) {
      return { ok: false, reason: 'insert-failed', error: err.message };
    }
  });
}

// ─── canonicalWrite ──────────────────────────────────────────────────────────
// Full write path. Reads prior content, scores, then accept/warn/disallow.
// Atomic file write via tmp + rename. INSERT inside BEGIN IMMEDIATE.

export function canonicalWrite(path, newContent, opts = {}) {
  return _enqueue(async () => {
    const { source, allowShrink = false, forceClass = null, storyId = null } = opts;
    if (!path || typeof path !== 'string') return { accepted: false, reason: 'invalid-path' };
    if (typeof newContent !== 'string') return { accepted: false, reason: 'invalid-content' };
    if (!source) return { accepted: false, reason: 'missing-source' };

    const key = canonicalKey(path);
    const absPath = expandPath(path);
    const klass = forceClass || canonicalClass(path);
    if (!klass) {
      return { accepted: false, reason: 'unclassified-surface' };
    }

    const surface = canonicalSurface(path);
    const size_floor = surface?.size_floor ?? null;

    // Look up the chain head for this doc.
    const head = db.prepare(`
      SELECT content_sha256, content_size FROM canonical_versions
       WHERE doc_path = ?
       ORDER BY id DESC LIMIT 1
    `).get(key);

    const newSha = sha256Hex(newContent);
    const newSize = Buffer.byteLength(newContent, 'utf8');

    // No prior row → genesis path. Allow only when caller is one of the
      // genesis-source enum values; production canonical doc edits should never
    // hit this branch.
    if (!head) {
      const genesisSources = new Set(['initial-revert', 'initial-classification', 'test']);
      if (!genesisSources.has(source)) {
        return {
          accepted: false,
          reason: 'no-prior-row',
          hint: 'Call canonicalGenesis() or run seed-canonical-genesis.js first.',
        };
      }
      // Delegate to canonicalGenesis (already serialized; we're inside the
      // queue, so we INSERT directly to avoid re-enqueueing).
      try {
        const insert = db.prepare(`
          INSERT INTO canonical_versions
            (doc_path, content_sha256, prev_sha256, content_size, regen_source, class, score_json, story_id)
          VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)
        `);
        const tx = db.transaction((args) => insert.run(...args));
        tx([key, newSha, newSize, source, klass, storyId || process.env.STORY_ID || null]);
        // Write the file if content differs from disk.
        _atomicWrite(absPath, newContent);
        return { accepted: true, prevSha: null, newSha, scoreJson: null };
      } catch (err) {
        return { accepted: false, reason: 'insert-failed', error: err.message };
      }
    }

    // Idempotent no-op: same content as current head.
    if (head.content_sha256 === newSha) {
      return { accepted: true, idempotent: true, prevSha: head.content_sha256, newSha, scoreJson: null };
    }

    // Read prior content from disk for scoring. If the file is missing
    // (e.g. the seed step ran but the file was deleted), we can't score —
    // require a re-seed via canonicalGenesis.
    let priorContent;
    try { priorContent = readFileSync(absPath, 'utf8'); }
    catch (err) {
      return {
        accepted: false,
        reason: 'prior-content-missing',
        error: err.message,
      };
    }
    // Defense in depth: prior on-disk content sha must match the chain head.
    // If not, someone wrote outside canonicalWrite — refuse and surface it.
    if (sha256Hex(priorContent) !== head.content_sha256) {
      // For programmatic class, we tolerate this with a warning — old generators
      // may have run before the chain was seeded. For human-authored,
      // it's a hard fail.
      if (klass === 'human-authored') {
        return {
          accepted: false,
          reason: 'chain-head-mismatch',
          hint: 'On-disk content differs from canonical_versions head. Investigate before writing.',
        };
      }
      process.stderr.write(
        `[canonical-write] WARN: ${key} on-disk sha differs from chain head (chain-resync)\n`,
      );
    }

    // Score — structural pre-gate (size-delta, header diff, embedding cosine).
    const embeddingCosine = await _maybeEmbedCosine(priorContent, newContent);
    const score = scoreCandidate(priorContent, newContent, {
      class: klass, allowShrink, size_floor, embeddingCosine,
    });
    const scoreJson = JSON.stringify(score);

    if (score.decision === 'disallow') {
      try {
        const q = db.prepare(`
          INSERT INTO canonical_versions_quarantine
            (doc_path, candidate_sha256, candidate_content, candidate_size,
             prior_sha256, prior_size, edit_delta, rejection_reason,
             score_json, regen_source, story_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const tx = db.transaction((args) => q.run(...args));
        const info = tx([
          key, newSha, newContent, newSize,
          head.content_sha256, head.content_size,
          newSize - head.content_size,
          score.rejection_reason, scoreJson, source,
          storyId || process.env.STORY_ID || null,
        ]);
        return {
          accepted: false,
          reason: score.rejection_reason,
          prevSha: head.content_sha256,
          newSha,
          scoreJson,
          quarantineId: info.lastInsertRowid,
        };
      } catch (err) {
        return { accepted: false, reason: 'quarantine-insert-failed', error: err.message };
      }
    }

    if (score.decision === 'warn') {
      process.stderr.write(
        `[canonical-write] WARN ${key}: ${score.reasons.join(', ')} (delta=${score.lengthDelta})\n`,
      );
    }

    // Main-write LLM scoring was removed under st_5285c160 (canonical-doc-hybrid).
    // Under the hand-curated regime, owner review at commit time is the gate.
    const qualityJson = null;

    // Accept (or warn-and-accept): INSERT row with quality_json, write file.
    try {
      const insert = db.prepare(`
        INSERT INTO canonical_versions
          (doc_path, content_sha256, prev_sha256, content_size, regen_source, class, score_json, story_id, quality_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const tx = db.transaction((args) => insert.run(...args));
      tx([
        key, newSha, head.content_sha256, newSize,
        source, klass, scoreJson, storyId || process.env.STORY_ID || null,
        qualityJson,
      ]);
      _atomicWrite(absPath, newContent);
      return {
        accepted: true,
        warn: score.decision === 'warn' ? score.reasons.join(',') : undefined,
        prevSha: head.content_sha256,
        newSha,
        scoreJson,
        qualityJson,
      };
    } catch (err) {
      return { accepted: false, reason: 'insert-failed', error: err.message };
    }
  });
}

// ─── canonicalRollback ───────────────────────────────────────────────────────
// Verifies target sha matches caller-provided content, then writes via
// canonicalWrite with source='rollback' and allowShrink=true.

export function canonicalRollback(path, targetSha, contentOverride = null) {
  return (async () => {
    if (!path || typeof path !== 'string') return { ok: false, reason: 'invalid-path' };
    if (!targetSha || typeof targetSha !== 'string') return { ok: false, reason: 'invalid-target' };

    const key = canonicalKey(path);
    const target = db.prepare(`
      SELECT content_sha256, content_size FROM canonical_versions
       WHERE doc_path = ? AND content_sha256 = ? LIMIT 1
    `).get(key, targetSha);
    if (!target) return { ok: false, reason: 'unknown-target-sha' };

    // Content recovery: caller may supply it, else try quarantine, else fail.
    let content = contentOverride;
    if (content == null) {
      const q = db.prepare(`
        SELECT candidate_content FROM canonical_versions_quarantine
         WHERE doc_path = ? AND candidate_sha256 = ? LIMIT 1
      `).get(key, targetSha);
      if (q) content = q.candidate_content;
    }
    // Fallback: if the live file already has this content (idempotent
    // rollback to head), use it directly.
    if (content == null) {
      try {
        const onDisk = readFileSync(expandPath(path), 'utf8');
        if (sha256Hex(onDisk) === targetSha) content = onDisk;
      } catch { /* file missing → fall through */ }
    }
    if (content == null) {
      return {
        ok: false,
        reason: 'cannot-recover-content',
        hint: 'Pass contentOverride explicitly (from git history or external store).',
      };
    }

    if (sha256Hex(content) !== targetSha) {
      return { ok: false, reason: 'content-sha-mismatch' };
    }

    const r = await canonicalWrite(path, content, {
      source: 'rollback', allowShrink: true, skipJudge: true,
    });
    if (!r.accepted) return { ok: false, reason: r.reason, detail: r };
    return { ok: true, newRowSha: r.newSha };
  })();
}

// ─── Atomic file write ───────────────────────────────────────────────────────
// tmp + rename mirrors lib/memory.js pattern; protects against partial writes
// if the process dies mid-write.
function _atomicWrite(absPath, content) {
  const dir = dirname(absPath);
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  const tmp = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, { mode: 0o644 });
  renameSync(tmp, absPath);
}

// ─── Testing helpers ─────────────────────────────────────────────────────────
export function _drainWriteQueue() {
  return _writeQueue;
}

export function _resetSurfacesCache() {
  _surfacesCache = { mtime: 0, byKey: new Map() };
}
