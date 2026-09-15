// lib/memory.js — hash-chained append-only memory log.
//
// Port of the Miyagi V1 protocol (~/.claude/projects/-Users-miyagi/memory/).
// Spec: docs/memory-log-spec.md. Logs live at ~/robotdojo/user/memory/log/.
//
// The log is authoritative. Anything derived — identity sections, topic
// contexts, MEMORY.md — is a projection that can be regenerated from the log.
// Correcting a past entry means appending a new one that supersedes it; never
// rewriting history.

import { readFile, writeFile, readdir, mkdir, rename, chmod, open, unlink, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { USER_MEMORY_DIR } from './robotdojo-paths.js';
import { resolveMemoryLogProvenance } from './provenance.js';

export const LOG_ROOT = process.env.ROBOTDOJO_MEMORY_DIR
  || USER_MEMORY_DIR;
export const LOG_DIR = join(LOG_ROOT, 'log');

// Cross-process lockfile for find-head → write. Without this, two terminals
// (e.g. Claude Code session + a CLI memory-append run) both call findChainHead
// before either writes, producing two entries with the same prev_hash and
// forking the chain. The in-process queue (below) covers concurrent callers
// inside one process; the lockfile covers concurrent processes.
//
// st_b9ec1b7c. Same lock contract is reimplemented in
// user/memory/bin/memory-append.js (CommonJS path); the two must agree on the
// lockfile path and TTL.
const APPEND_LOCK_PATH = join(LOG_DIR, '.append.lock');
// A normal append (write + rename + hash) takes <100 ms. 10 s is plenty of
// headroom and stays well under any operator's perceptible delay.
const APPEND_LOCK_TTL_MS = 10_000;
// 50 ms baseline poll keeps cold-start wait short while still letting the OS
// resolve EEXIST races without busy-spin.
const APPEND_LOCK_POLL_MS = 50;
const APPEND_LOCK_MAX_WAIT_MS = 30_000;

// Serialize all appends within this process. Without this, concurrent HTTP
// requests both call findChainHead() before either writes — producing a fork.
let _appendQueue = Promise.resolve();

// A broken chain can make every incoming session-log request scan the whole
// log and then fail. Cache the failure briefly so external hooks degrade fast
// while the operator repairs the chain.
const CHAIN_FAILURE_CACHE_MS = Number(process.env.ROBOTDOJO_MEMORY_CHAIN_FAILURE_CACHE_MS || 60_000);
let _chainHeadFailure = null;

const ALLOWED_TYPES = new Set([
  'user', 'feedback', 'project', 'reference', 'session-note', 'identity',
  // Session-bookmark is end-of-session state ("where we left off") and lands
  // in the curated chain via lib/session-log.js#logBookmark — a single entry
  // per session, low cardinality, useful for the next session's context.
  //
  // st_b9ec1b7c: `session-turn` was REMOVED from the allowed set on purpose.
  // Per-turn writes are the firehose that produced the 19,297 entries which
  // forked the chain. Turns now land only in user/transcripts/ via
  // logTurn; the chain stays reserved for curated entries + bookmarks.
  // The historical 19,297 turns were moved to user/memory/archive/session-turns/.
  'session-bookmark',
]);

const LOG_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{12}\.md$/;

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function utcIso(d = new Date()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function utcStamp(d = new Date()) {
  return utcIso(d).replace(/:/g, '-');
}

function parseTagsList(raw) {
  if (!raw) return [];
  // Frontmatter is written as `tags: [a, b, c]` — pull the inner list.
  const m = String(raw).match(/^\[(.*)\]$/);
  const inner = m ? m[1] : String(raw);
  return inner.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return {};
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return {};
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end < 0) return {};
  const fm = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    fm[m[1]] = m[2];
  }
  return fm;
}

// Shared by readEntryBody() (re-reads the file) and getLogIndex() (reuses
// bytes already read for parseFrontmatter, avoiding a second file read per
// entry) — one body-extraction rule, not two copies that could drift.
function extractBody(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') return content;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { end = i; break; }
  }
  if (end < 0) return content;
  return lines.slice(end + 1).join('\n').replace(/\n+$/, '');
}

// Acquire an exclusive lockfile in LOG_DIR. Returns { token, release }. The
// lockfile is mode 0600 and contains the holder's pid + acquisition timestamp
// + a per-acquisition fencing token (64-bit nonce). The token guards against
// the steal race below. Callers MUST call release() in a finally block.
//
// Algorithm:
//   1. mkdir LOG_DIR (idempotent).
//   2. Try fs.open(path, 'wx') — atomic exclusive create on the same
//      filesystem. On success, write the payload, return { token, release }.
//   3. On EEXIST, stat the existing lockfile; if older than TTL, unlink and
//      retry. Otherwise sleep for POLL_MS and try again, up to MAX_WAIT_MS.
//   4. After MAX_WAIT_MS, throw — the operator will see a clear error rather
//      than a silent fork.
//
// Why O_EXCL and not flock(): O_EXCL works on every filesystem Node supports
// (APFS, ext4, NFS) without native bindings. flock() is unreliable on NFS
// and would require platform-specific code paths.
//
// Fencing rationale (st_b9ec1b7c Bunshin AC4):
//   The TTL steal is needed so a crashed writer cannot deadlock the chain —
//   but without a token, a stall on the original writer (GC pause, fsync
//   latency on a busy disk) could let a peer steal the lock while the
//   original is still alive. Both would then commit, producing a fork.
//   The token lets the original writer detect the steal at commit time by
//   re-reading the lockfile; if the bytes no longer match it MUST abort
//   and retry the find-head→write under a fresh lock.
async function acquireAppendLock() {
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + APPEND_LOCK_MAX_WAIT_MS;
  // The token is the fencing nonce — 16 random bytes is far above birthday
  // collision risk across any plausible concurrent-writer count. The
  // payload is human-readable so a stuck operator can `cat` the lockfile
  // and see the offending pid and acquisition time.
  const token = `${process.pid}-${randomBytes(16).toString('hex')}`;
  const payload = JSON.stringify({
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    token,
  });

  while (true) {
    let handle;
    try {
      handle = await open(APPEND_LOCK_PATH, 'wx', 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Existing lockfile. Decide stale vs live by mtime — a recent file is
      // a live holder; an old one is left over from a crash.
      let st;
      try { st = await stat(APPEND_LOCK_PATH); }
      catch (statErr) {
        if (statErr.code === 'ENOENT') continue; // raced — try open again
        throw statErr;
      }
      const ageMs = Date.now() - st.mtimeMs;
      if (ageMs > APPEND_LOCK_TTL_MS) {
        // Best-effort steal. unlink + retry. If two processes both decide to
        // steal at the same instant the loser falls back to EEXIST and waits.
        try { await unlink(APPEND_LOCK_PATH); }
        catch (unlinkErr) {
          if (unlinkErr.code !== 'ENOENT') throw unlinkErr;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`memory: timed out waiting for ${APPEND_LOCK_PATH} (held by lockfile mtime ${st.mtime.toISOString()})`);
      }
      await new Promise((r) => setTimeout(r, APPEND_LOCK_POLL_MS));
      continue;
    }
    try {
      await handle.writeFile(payload, { mode: 0o600 });
    } finally {
      await handle.close();
    }
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      // Only unlink if we still own the lock. If a peer stole it (because
      // our slice ran past the TTL), the lockfile holds the peer's token
      // and unlinking it would yank their lock out from under them.
      try {
        const buf = await readFile(APPEND_LOCK_PATH);
        let owned = false;
        try { owned = JSON.parse(buf.toString('utf8')).token === token; }
        catch { owned = false; }
        if (owned) await unlink(APPEND_LOCK_PATH);
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    };
    return { token, release };
  }
}

// Re-read the lockfile and confirm it still holds our token. Used immediately
// before the commit rename so a writer whose slice exceeded TTL — and whose
// lock was therefore stolen by a peer — aborts instead of forking the chain.
//
// Returns true iff the lockfile exists and parses to a JSON object with
// matching token. Any other outcome (file missing, parse fail, token
// mismatch) is "we lost it" and the caller must retry under a fresh lock.
async function lockStillHeldBy(token) {
  let buf;
  try { buf = await readFile(APPEND_LOCK_PATH); }
  catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    return parsed && parsed.token === token;
  } catch { return false; }
}

async function listLogFiles() {
  try {
    const files = await readdir(LOG_DIR);
    return files.filter((n) => LOG_NAME_RE.test(n));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// The chain head is the unique entry whose self_hash is not referenced as
// prev_hash by any other entry. Walking by filename sort is unreliable
// because migrated entries carry historical timestamps in their names.
async function findChainHead() {
  if (
    _chainHeadFailure &&
    CHAIN_FAILURE_CACHE_MS > 0 &&
    Date.now() - _chainHeadFailure.at < CHAIN_FAILURE_CACHE_MS
  ) {
    throw new Error(_chainHeadFailure.message);
  }

  const logs = await listLogFiles();
  if (!logs.length) return null;
  const records = [];
  for (const name of logs) {
    const bytes = await readFile(join(LOG_DIR, name));
    const fm = parseFrontmatter(bytes.toString('utf8'));
    records.push({ name, selfHash: sha256Hex(bytes), prevHash: fm.prev_hash, bytes });
  }
  const referenced = new Set(records.map((r) => r.prevHash));
  const heads = records.filter((r) => !referenced.has(r.selfHash));
  if (heads.length !== 1) {
    const message = `memory: expected exactly one chain head, found ${heads.length}. Run verifyChain() to diagnose.`;
    _chainHeadFailure = { message, at: Date.now() };
    throw new Error(message);
  }
  _chainHeadFailure = null;
  return heads[0];
}

export function _resetMemoryChainFailureForTest() {
  _chainHeadFailure = null;
}

// Test-only exports for the append-lock fencing path (st_b9ec1b7c AC4).
// Production callers should never use these directly — the public surface
// is appendMemory(), which loops and retries on steal automatically.
export const _testInternals = {
  acquireAppendLock,
  lockStillHeldBy,
  APPEND_LOCK_PATH,
};

/**
 * Append a new entry to the log.
 *
 * @param {object} opts
 * @param {'user'|'feedback'|'project'|'reference'|'session-note'|'identity'} opts.type
 * @param {string} opts.name         kebab-case, [a-z0-9][a-z0-9-]*
 * @param {string} opts.description  one-line
 * @param {string} opts.author       e.g. 'miyagi' | 'owner' | 'chat'. Recorded
 *   verbatim but does NOT drive provenance (Chunk 7A) — every entry is
 *   authored by an agent process in practice, so `author` cannot be the
 *   authoritative signal.
 * @param {string} opts.body         markdown body. Drives the stamped
 *   `source_class`/`status` (Chunk 7A, `lib/provenance.js#isOwnerGrounded`):
 *   a body that attributes a quote to the owner (`Owner: '...'`) stamps
 *   `user-stated`; anything else stamps `llm-distilled` + `status:
 *   provisional` — not a caller-settable option.
 * @param {string} [opts.section]    required for type=identity (e.g. 'soul')
 * @param {string} [opts.sessionId]
 * @param {string[]} [opts.tags]
 * @returns {Promise<{ path, prevHash, selfHash, name }>}
 */
export function appendMemory(opts) {
  const result = _appendQueue.then(() => _appendMemoryImpl(opts));
  _appendQueue = result.catch(() => {});
  return result;
}

async function _appendMemoryImpl({
  type, name, description, author, body,
  section = null, sessionId = null, tags = null,
  threadId = null, source = null,
}) {
  if (!type || !name || !description || !author || body === undefined) {
    throw new Error('appendMemory: type, name, description, author, body are required');
  }
  if (!ALLOWED_TYPES.has(type)) {
    throw new Error(`appendMemory: invalid type "${type}"; allowed: ${[...ALLOWED_TYPES].join(', ')}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`appendMemory: name must be kebab-case, got "${name}"`);
  }
  if (type === 'identity' && !section) {
    throw new Error('appendMemory: identity entries require section (e.g. soul, user, voice)');
  }

  // mkdir is idempotent; acquireAppendLock also mkdirs but we keep this here
  // for the case where the lock is somehow bypassed (e.g. test harness mocks).
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 });

  // st_b9ec1b7c. Lock spans find-head→write so no peer can read the same head
  // and produce a sibling entry. Bounded retry: if our slice exceeds TTL and
  // a peer steals the lock between find-head and rename, we detect it via
  // the fencing token, abort the current attempt (deleting the tmp file),
  // and re-acquire to recompute head + write. 5 attempts is more than enough
  // for any plausible contention pattern; beyond that the operator deserves
  // a hard failure rather than a silent retry storm.
  const MAX_ATTEMPTS = 5;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const { token, release } = await acquireAppendLock();
    let tmpPath = null;
    try {
      const head = await findChainHead();
      const prevHash = head ? head.selfHash : 'genesis';

      const now = new Date();
      const fm = ['---'];
      fm.push(`timestamp: ${utcIso(now)}`);
      fm.push(`type: ${type}`);
      fm.push(`name: ${name}`);
      fm.push(`description: ${description}`);
      fm.push(`prev_hash: ${prevHash}`);
      fm.push(`author: ${author}`);
      // Chunk 7A provenance guard, revised (st_5184eb86 §7A): source_class/
      // status are DERIVED from whether `body` actually attributes a quote
      // to the owner (isOwnerGrounded) — never from `author` (every entry
      // is authored by an agent process per the memory protocol, so
      // `author === 'owner'` never happens) and never from a caller option
      // (this function has no sourceClass/status parameter at all). An
      // agent cannot mark its own ungrounded conclusion as authoritative:
      // no owner quote in body -> forced llm-distilled/provisional,
      // regardless of author. See lib/provenance.js#isOwnerGrounded.
      const { sourceClass, status: provenanceStatus } = resolveMemoryLogProvenance({ body });
      fm.push(`source_class: ${sourceClass}`);
      if (provenanceStatus) fm.push(`status: ${provenanceStatus}`);
      if (section) fm.push(`section: ${section}`);
      if (threadId) fm.push(`thread_id: ${threadId}`);
      if (source) fm.push(`source: ${source}`);
      if (sessionId) fm.push(`session_id: ${sessionId}`);
      if (tags && tags.length) fm.push(`tags: [${tags.join(', ')}]`);
      fm.push('---');
      const content = fm.join('\n') + '\n' + body + (body.endsWith('\n') ? '' : '\n');

      tmpPath = join(LOG_DIR, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
      await writeFile(tmpPath, content, { mode: 0o600 });

      const bytesWritten = await readFile(tmpPath);
      const selfHash = sha256Hex(bytesWritten);
      const hash12 = selfHash.slice(0, 12);

      const finalName = `${utcStamp(now)}-${hash12}.md`;
      const finalPath = join(LOG_DIR, finalName);

      // Fencing check — the SQLite "have we still got the lock" moment.
      // If the lockfile no longer holds our token, the TTL-based steal
      // mechanism handed our spot to a peer while we were inside the
      // critical section. Aborting here and retrying under a fresh lock
      // is the only thing that prevents a fork: the peer has already
      // recomputed head and will write its own entry; if we proceed we
      // both write entries pointing at the same prev_hash.
      if (!(await lockStillHeldBy(token))) {
        // Best-effort cleanup of our staged tmp file. If unlink fails (the
        // peer's release may have already swept it), no-op — listLogFiles
        // ignores tmp prefixes.
        try { await unlink(tmpPath); } catch { /* swept */ }
        tmpPath = null;
        lastErr = new Error('memory: lock was stolen mid-append; retrying');
        continue;
      }

      await rename(tmpPath, finalPath);
      tmpPath = null;
      await chmod(finalPath, 0o600);

      return { path: finalPath, prevHash, selfHash, name: finalName };
    } finally {
      if (tmpPath) { try { await unlink(tmpPath); } catch { /* nothing to clean */ } }
      await release();
    }
  }
  throw lastErr || new Error(`memory: ${MAX_ATTEMPTS} consecutive lock steals — chain under sustained contention`);
}

/**
 * Walk the chain from genesis → head via prev_hash.
 * @returns {Promise<{ ok, count, genesis?, head?, headHash?, error? }>}
 */
export async function verifyChain() {
  const logs = await listLogFiles();
  if (!logs.length) return { ok: true, count: 0, genesis: null, head: null };

  const byPrevHash = new Map();
  let genesis = null;

  for (const name of logs) {
    const bytes = await readFile(join(LOG_DIR, name));
    const fm = parseFrontmatter(bytes.toString('utf8'));
    if (!fm.prev_hash) return { ok: false, count: 0, error: `${name}: missing prev_hash` };

    const selfHash = sha256Hex(bytes);
    const declaredSuffix = name.slice(-15, -3);
    if (selfHash.slice(0, 12) !== declaredSuffix) {
      return { ok: false, count: 0, error: `${name}: filename suffix ${declaredSuffix} != sha256 prefix ${selfHash.slice(0, 12)}` };
    }

    if (byPrevHash.has(fm.prev_hash)) {
      return {
        ok: false, count: 0,
        error: `fork at prev_hash ${fm.prev_hash}: ${byPrevHash.get(fm.prev_hash).name} and ${name}`,
      };
    }
    byPrevHash.set(fm.prev_hash, { name, fm, selfHash });

    if (fm.prev_hash === 'genesis') {
      if (genesis) return { ok: false, count: 0, error: `multiple genesis entries: ${genesis.name} and ${name}` };
      genesis = { name, selfHash };
    }
  }

  if (!genesis) return { ok: false, count: 0, error: 'no genesis entry' };

  let cursorHash = genesis.selfHash;
  let headName = genesis.name;
  let count = 1;
  const visited = new Set([genesis.name]);
  while (true) {
    const next = byPrevHash.get(cursorHash);
    if (!next) break;
    if (visited.has(next.name)) return { ok: false, count, error: `cycle at ${next.name}` };
    visited.add(next.name);
    cursorHash = next.selfHash;
    headName = next.name;
    count++;
  }

  const orphans = logs.filter((n) => !visited.has(n));
  if (orphans.length) {
    return { ok: false, count, error: `${orphans.length} orphan(s) not reachable from genesis: ${orphans.slice(0, 3).join(', ')}` };
  }

  return { ok: true, count, genesis: genesis.name, head: headName, headHash: cursorHash };
}

/**
 * List entries with parsed frontmatter, in chain order, newest first.
 *
 * We walk the hash chain (genesis → head) to establish order, because
 * filename-timestamps only have second-level precision and can collide on
 * rapid successive appends. The chain is the authoritative ordering.
 * @returns {Promise<Array<{ name, timestamp, type, description, section, author, sourceClass, status, tags, path }>>}
 */
export async function getLogIndex() {
  const logs = await listLogFiles();
  if (!logs.length) return [];

  const entries = new Map(); // selfHash -> record
  const byPrev = new Map();  // prev_hash -> record
  let genesis = null;

  for (const name of logs) {
    const full = join(LOG_DIR, name);
    const bytes = await readFile(full);
    const content = bytes.toString('utf8');
    const fm = parseFrontmatter(content);
    const selfHash = sha256Hex(bytes);
    // Chunk 7A (revised): resolve source_class/status at read time from the
    // BODY, not frontmatter or `author` — identically for a legacy entry
    // and a freshly-written one, so the log stays append-only (no rewrite)
    // and a stray/forged frontmatter tag can never diverge from what the
    // body actually supports. See lib/provenance.js#isOwnerGrounded.
    const { sourceClass, status } = resolveMemoryLogProvenance({ body: extractBody(content) });
    const record = {
      name: fm.name || name,
      timestamp: fm.timestamp || null,
      type: fm.type || null,
      description: fm.description || '',
      section: fm.section || null,
      threadId: fm.thread_id || null,
      source: fm.source || null,
      author: fm.author || null,
      sourceClass,
      status,
      tags: parseTagsList(fm.tags),
      path: full,
      _selfHash: selfHash,
      _prevHash: fm.prev_hash,
    };
    entries.set(selfHash, record);
    if (fm.prev_hash) byPrev.set(fm.prev_hash, record);
    if (fm.prev_hash === 'genesis') genesis = record;
  }

  // Walk genesis → head.
  const ordered = [];
  if (genesis) {
    let cursor = genesis;
    const seen = new Set();
    while (cursor) {
      if (seen.has(cursor._selfHash)) break; // defensive
      seen.add(cursor._selfHash);
      ordered.push(cursor);
      cursor = byPrev.get(cursor._selfHash);
    }
  }

  // Append any orphans at the end in filename order (they won't appear in a
  // healthy chain; included so callers can still see them).
  if (ordered.length < entries.size) {
    const inChain = new Set(ordered.map((r) => r._selfHash));
    for (const name of logs) {
      for (const [, r] of entries) {
        if (r.path.endsWith(name) && !inChain.has(r._selfHash)) ordered.push(r);
      }
    }
  }

  // Caller wants newest first: reverse.
  ordered.reverse();

  // Strip private fields.
  return ordered.map(({ _selfHash, _prevHash, ...rest }) => rest);
}

/**
 * Return the body of an entry (everything after the closing ---).
 */
export async function readEntryBody(filePath) {
  const content = await readFile(filePath, 'utf8');
  return extractBody(content);
}
