/**
 * lib/claude-code-jsonl.js — native Claude Code session-log (.jsonl) parser.
 *
 * The keystone of st_abf246e4. The live save path (the Stop hook) captures only
 * the owner's prompts and the tool firehose — never the agent's replies. The
 * complete two-sided record exists ONLY in the native `.jsonl` Claude Code
 * writes to ~/.claude/projects/<projdir>/<sessionId>.jsonl. This parser is the
 * single source of two-sided reconstruction, shared by live capture (WS1),
 * historical recovery (WS2), and two-sided rendering (WS4).
 *
 * Compute tier: Tier-0, deterministic, no LLM. Pure line parse + link-list
 * linearization. Topic classification happens downstream in the materializer.
 *
 * Record shape (verified against live logs):
 *   - Each line is one JSON object with `type`, `uuid`, `parentUuid`,
 *     `sessionId`, `isSidechain`, `timestamp`, `message`.
 *   - type='user'      → message.content is a STRING (a real prompt) OR an
 *                        array of tool_result blocks (tool output — dropped).
 *   - type='assistant' → message.content is an ARRAY of blocks: `text` (kept),
 *                        `tool_use` / `thinking` (dropped).
 *   - isSidechain=true marks a spawned sub-agent thread; false is the owner
 *     thread. It is the ONLY reliable owner-vs-subagent signal at parse time.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { homedir } from 'node:os';

const CLAUDE_PROJECTS_DIR = resolve(homedir(), '.claude', 'projects');

/**
 * Linearize records by their parentUuid link list.
 *
 * Claude Code threads its records as a linked list: every record carries a
 * `uuid` and a `parentUuid` (null on the first record). Following the chain —
 * not the raw file order — is what produces a correct transcript even when a
 * session branched (an edited prompt creates two children of the same parent).
 * Siblings keep their file order; any record whose parent is missing is treated
 * as a root. Records the walk never reaches are appended defensively so nothing
 * is silently dropped.
 *
 * @param {object[]} records
 * @returns {object[]}
 */
function orderByParent(records) {
  const byUuid = new Map();
  for (const r of records) if (r.uuid) byUuid.set(r.uuid, r);

  const children = new Map();
  const roots = [];
  for (const r of records) {
    const parent = r.parentUuid;
    if (parent && byUuid.has(parent)) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(r);
    } else {
      roots.push(r);
    }
  }

  const ordered = [];
  const seen = new Set();
  const visit = (r) => {
    if (!r || (r.uuid && seen.has(r.uuid))) return;
    if (r.uuid) seen.add(r.uuid);
    ordered.push(r);
    for (const child of children.get(r.uuid) || []) visit(child);
  };
  for (const r of roots) visit(r);
  // Defensive: append anything the walk missed (cycle / duplicate uuid).
  for (const r of records) if (!r.uuid || !seen.has(r.uuid)) {
    if (!ordered.includes(r)) ordered.push(r);
  }
  return ordered;
}

/**
 * Extract the human-facing text from one assistant record's content array.
 * Keeps `text` blocks; drops `tool_use` and `thinking`. Returns '' when the
 * record carried no text (a pure tool-call turn).
 *
 * @param {any} content
 * @returns {string}
 */
function assistantText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const t = block.text.trim();
      if (t) parts.push(t);
    }
  }
  return parts.join('\n\n');
}

/**
 * Parse one native Claude Code session `.jsonl` into a two-sided message list.
 *
 * @param {string} filePath — absolute path to a <sessionId>.jsonl
 * @returns {{ sessionId: string, isSidechain: boolean,
 *            messages: {role:string, content:string, created_at:string|null}[],
 *            hasAssistant: boolean, firstTs: string|null, lastTs: string|null }}
 */
export function parseSessionJsonl(filePath) {
  const sessionId = basename(filePath).replace(/\.jsonl$/i, '');
  let raw = '';
  try { raw = readFileSync(filePath, 'utf8'); }
  catch { return emptyResult(sessionId); }

  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (obj && (obj.type === 'user' || obj.type === 'assistant')) records.push(obj);
  }
  if (!records.length) return emptyResult(sessionId);

  const ordered = orderByParent(records);

  // A session is a sidechain if ANY of its message records is marked so — a
  // subagent file carries isSidechain=true throughout; the flag propagates.
  const isSidechain = ordered.some((r) => r.isSidechain === true);

  const messages = [];
  const timestamps = [];
  for (const r of ordered) {
    const created_at = typeof r.timestamp === 'string' ? r.timestamp : null;
    if (r.type === 'user') {
      const content = r.message?.content;
      // Only real string prompts survive; array content is tool_result output.
      if (typeof content === 'string' && content.trim()) {
        messages.push({ role: 'user', content: content.trim(), created_at });
        if (created_at) timestamps.push(created_at);
      }
    } else if (r.type === 'assistant') {
      const text = assistantText(r.message?.content);
      if (text) {
        messages.push({ role: 'assistant', content: text, created_at });
        if (created_at) timestamps.push(created_at);
      }
    }
  }

  const hasAssistant = messages.some((m) => m.role === 'assistant');
  timestamps.sort();
  const firstTs = timestamps[0] || null;
  const lastTs = timestamps[timestamps.length - 1] || null;

  return { sessionId, isSidechain, messages, hasAssistant, firstTs, lastTs };
}

function emptyResult(sessionId) {
  return { sessionId, isSidechain: false, messages: [], hasAssistant: false, firstTs: null, lastTs: null };
}

/**
 * Locate the local native jsonl for a sessionId across all project dirs.
 * Claude Code files a session at ~/.claude/projects/<projdir>/<sessionId>.jsonl;
 * the project dir is the cwd-encoded name, so we scan every project dir for the
 * session-named file. Returns the absolute path or null.
 *
 * @param {string} sessionId
 * @param {string} [projectsDir] — override for tests
 * @returns {string|null}
 */
export function findLocalSessionJsonl(sessionId, projectsDir = CLAUDE_PROJECTS_DIR) {
  if (!sessionId) return null;
  const fileName = `${sessionId}.jsonl`;
  let dirs;
  try { dirs = readdirSync(projectsDir, { withFileTypes: true }); }
  catch { return null; }
  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const candidate = join(projectsDir, dirent.name, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export const CLAUDE_CODE_PROJECTS_DIR = CLAUDE_PROJECTS_DIR;
