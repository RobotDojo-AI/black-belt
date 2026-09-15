/**
 * lib/claude-code-reconcile.js — catch-up reconciliation for coding-agent
 * sessions (st_abf246e4 WS1).
 *
 * The live Stop hook is push-based and lossy (Claude Code upstream #29881: Stop
 * can silently not fire). The guarantee is a PULL: diff the local session logs
 * against what is materialized and import the gap. This is the event-sourcing
 * catch-up subscription — the native jsonl + transcript store are the source-of-
 * truth log; the push hook is a latency optimization, not the guarantee.
 *
 * Compute tier: Tier-0 enumeration (free); the per-session materialize rides the
 * existing Tier-0→Tier-1 topic ladder inside materializeSession. Off the HTTP
 * path — it runs on the maintenance worker in bounded, resumable slices.
 *
 * Idempotent on `thread_id`: a session already materialized (or with no new
 * turns) is skipped, so re-running never duplicates a row.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { REPO_ROOT } from './robotdojo-paths.js';
import { materializeSession } from './conversations.js';
import { parseSessionJsonl, findLocalSessionJsonl } from './claude-code-jsonl.js';

const CLAUDE_PROJECTS_DIR = resolve(homedir(), '.claude', 'projects');
const THREAD_PREFIX = 'claude-code:';
// The transcript format writes one `**user:**` / `**assistant:**` header per turn.
const TRANSCRIPT_USER_MARKER = /^\*\*user:\*\*/mi;
// Claude Code session ids are UUIDs; the transcript filename ends with the id.
const SESSION_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.md$/i;

function claudeCodeTranscriptDir() {
  const userRoot = process.env.ROBOTDOJO_USER_ROOT
    ? resolve(process.env.ROBOTDOJO_USER_ROOT)
    : join(REPO_ROOT, 'user');
  const transcriptsRoot = process.env.ROBOTDOJO_TRANSCRIPTS_ROOT
    ? resolve(process.env.ROBOTDOJO_TRANSCRIPTS_ROOT)
    : join(userRoot, 'transcripts');
  return join(transcriptsRoot, 'chat', 'sessions', 'claude-code');
}

/**
 * Map sessionId → native jsonl path across every project dir (top level only —
 * the same locations findLocalSessionJsonl resolves, so enumeration and lookup
 * never disagree).
 * @returns {Map<string,string>}
 */
function nativeSessionFileMap() {
  const map = new Map();
  let dirs;
  try { dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true }); }
  catch { return map; }
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    let files;
    try { files = readdirSync(join(CLAUDE_PROJECTS_DIR, dirent.name)); }
    catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const sid = f.replace(/\.jsonl$/i, '');
      if (!map.has(sid)) map.set(sid, join(CLAUDE_PROJECTS_DIR, dirent.name, f));
    }
  }
  return map;
}

/**
 * Map sessionId → transcript .md paths. One session fragments across many files
 * (the transcript path falls back to a per-process date), so dedup by the
 * session id embedded in the filename, never by file.
 * @returns {Map<string,string[]>}
 */
function transcriptSessionFileMap() {
  const map = new Map();
  const dir = claudeCodeTranscriptDir();
  let files;
  try { files = readdirSync(dir); }
  catch { return map; }
  for (const f of files) {
    if (!f.endsWith('.md')) continue;
    const m = basename(f).match(SESSION_UUID_RE);
    if (!m) continue;
    const sid = m[1].toLowerCase();
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(join(dir, f));
  }
  return map;
}

/**
 * Enumerate all local coding-agent session ids (native jsonl + transcript
 * store), deduped by session id.
 * @returns {string[]}
 */
export function listLocalSessionIds() {
  const native = nativeSessionFileMap();
  const transcript = transcriptSessionFileMap();
  return [...new Set([...native.keys(), ...transcript.keys()])];
}

/**
 * Does this session have at least one user turn (so it can materialize)? Native
 * jsonl is authoritative; otherwise scan the transcript fragments for a user
 * marker. Synchronous by design — the AC1 criterion calls
 * unreconciledSessionIds(db).length inline.
 */
function sessionHasUserTurn(sid, nativeMap, transcriptMap) {
  const jsonlPath = nativeMap.get(sid);
  if (jsonlPath) {
    try {
      const parsed = parseSessionJsonl(jsonlPath);
      return parsed.messages.some((m) => m.role === 'user');
    } catch { /* fall through to transcript scan */ }
  }
  for (const mdPath of transcriptMap.get(sid) || []) {
    try {
      if (TRANSCRIPT_USER_MARKER.test(readFileSync(mdPath, 'utf8'))) return true;
    } catch { /* unreadable fragment */ }
  }
  return false;
}

/**
 * Local session ids with ≥1 user turn whose `claude-code:<sid>` is NOT yet in
 * conversations.thread_id. Empty ⇒ every capturable local session is captured.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string[]}
 */
export function unreconciledSessionIds(db) {
  const rows = db.prepare(
    "SELECT thread_id FROM conversations WHERE thread_id LIKE 'claude-code:%'"
  ).all();
  const materialized = new Set(rows.map((r) => r.thread_id.slice(THREAD_PREFIX.length)));

  const nativeMap = nativeSessionFileMap();
  const transcriptMap = transcriptSessionFileMap();
  const allSids = new Set([...nativeMap.keys(), ...transcriptMap.keys()]);

  const out = [];
  for (const sid of allSids) {
    if (materialized.has(sid)) continue;
    if (sessionHasUserTurn(sid, nativeMap, transcriptMap)) out.push(sid);
  }
  return out;
}

/** Owner coding chats currently surfaced but one-sided (candidates to enrich). */
function surfacedOneSidedThreadIds(db) {
  return db.prepare(
    `SELECT thread_id FROM conversations
     WHERE model = 'claude-code' AND thread_id IS NOT NULL
       AND (archived IS NULL OR archived = 0) AND deleted_at IS NULL
       AND (origin IS NULL OR origin = 'owner')
       AND id NOT IN (SELECT DISTINCT conversation_id FROM messages WHERE role = 'assistant')`
  ).all().map((r) => r.thread_id);
}

/**
 * Materialize/enrich local coding sessions, bounded by a wall-clock budget and
 * resumable across slices (idempotent on thread_id):
 *   1. capture every unreconciled session (AC1);
 *   2. enrich existing surfaced one-sided owner rows from their jsonl so a
 *      legacy user-only row becomes two-sided where the agent side survives (AC3);
 *   3. on a COMPLETE pass, hide any owner coding chat still surfaced one-sided —
 *      a one-sided fragment is never shown (AC3/OOS#5); reversible via archived,
 *      and a later jsonl recovery re-enriches and unarchives it.
 *
 * The hide step runs only when the pass completed (not partial), so a session
 * not yet reached in a bounded slice stays surfaced+one-sided (still in the work
 * set) and is retried next slice instead of being hidden prematurely.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{maxSeconds?: number}} [opts]
 * @returns {Promise<{total:number, processed:number, materialized:number, enriched:number, hidden:number, remaining:number, partial:boolean}>}
 */
export async function reconcileSessions(db, { maxSeconds = 240 } = {}) {
  const deadline = maxSeconds > 0 ? Date.now() + maxSeconds * 1000 : null;
  const pending = unreconciledSessionIds(db);

  const workThreads = [];
  const seen = new Set();
  const pushThread = (threadId) => { if (!seen.has(threadId)) { seen.add(threadId); workThreads.push(threadId); } };
  for (const sid of pending) pushThread(`${THREAD_PREFIX}${sid}`);
  for (const threadId of surfacedOneSidedThreadIds(db)) pushThread(threadId);

  let processed = 0;
  let materialized = 0;
  let enriched = 0;
  let partial = false;

  for (const threadId of workThreads) {
    if (deadline !== null && Date.now() >= deadline) { partial = true; break; }
    try {
      const res = await materializeSession(db, threadId);
      if (res?.materialized) materialized += 1;
      else if (res?.enriched) enriched += 1;
    } catch (e) {
      console.warn('[claude-code-reconcile] materialize failed for', threadId, e?.message || e);
    }
    processed += 1;
  }

  let hidden = 0;
  if (!partial) {
    hidden = db.prepare(
      `UPDATE conversations SET archived = 1, updated_at = datetime('now')
       WHERE model = 'claude-code' AND (archived IS NULL OR archived = 0)
         AND deleted_at IS NULL AND (origin IS NULL OR origin = 'owner')
         AND id NOT IN (SELECT DISTINCT conversation_id FROM messages WHERE role = 'assistant')`
    ).run().changes;
  }

  return {
    total: workThreads.length,
    processed,
    materialized,
    enriched,
    hidden,
    remaining: workThreads.length - processed,
    partial,
  };
}

// Re-export for callers that want the lookup alongside enumeration.
export { findLocalSessionJsonl };
