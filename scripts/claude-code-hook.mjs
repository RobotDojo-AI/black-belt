#!/usr/bin/env node
// scripts/claude-code-hook.mjs — Claude Code session-log hook.
//
// Installed to ~/.claude/hooks/robotdojo-session-log.mjs and invoked by
// Claude Code on UserPromptSubmit, PostToolUse, and Stop events. Posts each
// turn to the local robotdojo /api/session-log/turn endpoint so it lands in
// the user's hash-chained memory log.
//
// st_8745309c: also writes session liveness into the shared session
// registry (lib/session-registry.js) so all parallel terminals can see
// each other. The registry write is best-effort; a failed write does not
// block the session-log post.
//
// Contract: fire-and-forget. Must NEVER block Claude Code (strict 800ms
// timeout + abort). Must never throw (all errors swallowed). If the local
// robotdojo isn't running, the hook silently no-ops.
//
// Event routing (CLI arg):
//   prompt   ← UserPromptSubmit   → role=user, content=event.prompt
//                                   + upsertSession heartbeat
//   tool     ← PostToolUse        → role=tool, toolName + input/response JSON
//   stop     ← Stop               → bookmark + removeSession from registry
//   subagentstop ← SubagentStop   → role=system 'subagent-stop' → materialize
//                                   (live capture for sidechain completions)

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

function resolvePort() {
  if (process.env.ROBOTDOJO_PORT) return process.env.ROBOTDOJO_PORT;
  try {
    const portFile = resolve(homedir(), '.robotdojo', '.http-port');
    return readFileSync(portFile, 'utf8').trim();
  } catch { /* file not yet written — use fallback */ }
  return process.env.PORT_APP || '4339';
}

const EVENT_TYPE = process.argv[2] || 'unknown';
const PORT = resolvePort();
const ENDPOINT = `http://127.0.0.1:${PORT}/api/session-log/turn`;
const TIMEOUT_MS = 800;

function getToken() {
  if (process.env.ROBOTDOJO_AUTH_TOKEN) return process.env.ROBOTDOJO_AUTH_TOKEN;
  try {
    return execSync(
      'security find-generic-password -w -s robotdojo-ROBOTDOJO_AUTH_TOKEN 2>/dev/null',
      { encoding: 'utf8', timeout: 500 },
    ).trim();
  } catch {
    return '';
  }
}

// Stable thread_id per Claude Code session. Prefer the session_id from the
// event JSON if provided; otherwise fall back to working-dir + day.
function threadIdFromEvent(event) {
  const fromEvent = event?.session_id || event?.sessionId || event?.conversation_id;
  if (fromEvent) return `claude-code:${fromEvent}`;
  const cwd = process.cwd().replace(/[^a-zA-Z0-9]/g, '-').slice(-40);
  const day = new Date().toISOString().slice(0, 10);
  return `claude-code:${cwd}:${day}`;
}

async function post(body) {
  const token = getToken();
  if (!token) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return await resp.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function readStdin() {
  let raw = '';
  try {
    for await (const chunk of process.stdin) raw += chunk;
  } catch { return null; }
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); }
  catch { return null; }
}

// st_8745309c — best-effort registry write. Imported lazily so the hook
// keeps working even when the repo at ~/robotdojo is moved or unreachable.
// All errors are swallowed; this is awareness data, not durable state.
async function loadRegistry() {
  try {
    const modulePath = resolve(homedir(), 'robotdojo', 'lib', 'session-registry.js');
    return await import(pathToFileURL(modulePath).href);
  } catch {
    return null;
  }
}

// st_1cfe9061 AC-11: auto-detect story_id from the current git branch.
// Branch naming convention: story/<st_XXXXXXXX>[-<slug>]
// Returns the story_id string (e.g. "st_1cfe9061") or null.
function extractStoryIdFromBranch() {
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = result.match(/^story\/(st_[a-f0-9]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function sessionIdFromEvent(event) {
  return event?.session_id || event?.sessionId || event?.conversation_id || null;
}

// Per-process scratch file the in-session scripts (story-init.js,
// story-gate.js) can read to discover the stable session_id without an
// env var propagation chain. Each session has exactly one path keyed by
// PID. Cleaned up by the OS on temp rotation.
function sessionScratchPath() {
  return resolve(tmpdir(), `robotdojo-session-${process.pid}.json`);
}

function writeSessionScratch({ session_id, label, story_id }) {
  try {
    const payload = { session_id, label, story_id: story_id || null, pid: process.pid };
    writeFileSync(sessionScratchPath(), JSON.stringify(payload));
  } catch { /* best-effort */ }
}

async function registryHeartbeat(event) {
  const session_id = sessionIdFromEvent(event);
  if (!session_id) return;
  const reg = await loadRegistry();
  if (!reg) return;

  const label = process.env.ROBOTDOJO_SESSION_LABEL || session_id.slice(-6);
  // st_1cfe9061 AC-11: fall back to branch-derived story_id when the env var
  // is not set. extractStoryIdFromBranch() is synchronous and best-effort.
  const story_id = process.env.ROBOTDOJO_ACTIVE_STORY_ID || extractStoryIdFromBranch() || null;
  const worktree_path = process.env.ROBOTDOJO_WORKTREE === '1' ? process.cwd() : null;

  writeSessionScratch({ session_id, label, story_id });

  try {
    reg.upsertSession({
      session_id,
      label,
      story_id,
      worktree_path,
      pid: process.pid,
    });
  } catch { /* best-effort */ }
}

async function registryRemove(event) {
  const session_id = sessionIdFromEvent(event);
  if (!session_id) return;
  const reg = await loadRegistry();
  if (!reg) return;
  try {
    reg.removeSession({ session_id });
  } catch { /* best-effort */ }
}

function touchTopicWorkActivity() {
  try {
    const stories = process.env.ROBOTDOJO_STORIES_DIR
      || join(homedir(), 'robotdojo/user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories');
    const wanted = String(process.env.ROBOTDOJO_ACTIVE_STORY_ID || '').trim();
    const names = wanted ? [wanted] : readdirSync(stories);
    const matches = [];
    for (const name of names) {
      const dir = join(stories, name);
      const metaPath = join(dir, 'meta.json');
      if (!existsSync(metaPath)) continue;
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      if (meta.type !== 'work') continue;
      if (!['in-progress', 'active'].includes(String(meta.kanban || ''))) continue;
      if (!existsSync(join(dir, 'open-payload.json'))) continue;
      matches.push(dir);
    }
    const idleMs = 30 * 60 * 1000;
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    for (const dir of matches) {
      if (wanted) {
        writeFileSync(join(dir, 'last-activity'), stamp, 'utf8');
        continue;
      }
      let last = 0;
      try { last = Date.parse(readFileSync(join(dir, 'last-activity'), 'utf8').trim()) || 0; } catch {}
      if (!last) last = now;
      if ((now - last) < idleMs) writeFileSync(join(dir, 'last-activity'), stamp, 'utf8');
    }
  } catch { /* never block the coding agent */ }
}

async function main() {
  const event = await readStdin();
  if (!event) return;
  const threadId = threadIdFromEvent(event);

  if (EVENT_TYPE === 'prompt') {
    touchTopicWorkActivity();
    // Fire registry heartbeat in parallel with the session-log post — both
    // are best-effort and neither blocks the other.
    const beat = registryHeartbeat(event);
    const content = event.prompt || event.user_prompt || '';
    if (content) {
      await post({ source: 'claude-code', threadId, role: 'user', content });
    }
    await beat;
  } else if (EVENT_TYPE === 'tool') {
    touchTopicWorkActivity();
    // st_8745309c QA fix: heartbeat on tool calls too. Liveness is now
    // heartbeat-based (lib/session-registry.js), so a long agent turn that
    // makes tool calls for >60s with no new user prompt would otherwise let
    // the live session go stale and vanish from the roster mid-work. Tool
    // events keep it fresh. Best-effort, parallel with the post.
    const beat = registryHeartbeat(event);
    const toolName = event.tool_name || event.toolName || 'unknown';
    const content = JSON.stringify({
      input: event.tool_input ?? event.toolInput ?? null,
      response: event.tool_response ?? event.toolResponse ?? null,
    });
    await post({
      source: 'claude-code', threadId, role: 'tool',
      toolName, content, summary: `tool: ${toolName}`,
    });
    await beat;
  } else if (EVENT_TYPE === 'stop') {
    // Stop hook doesn't reliably carry the assistant response text. Log a
    // lightweight marker so the projection knows where the session ended.
    const result = await post({
      source: 'claude-code', threadId, role: 'system',
      content: 'session-stop',
      summary: 'claude-code session ended',
    });
    if (result && result.materialized === false) {
      console.warn('[robotdojo] session-stop: materialized=false — duplicate session or no user turns logged');
    }
    // st_8745309c — clean exit removes the registry entry.
    await registryRemove(event);
  } else if (EVENT_TYPE === 'subagentstop') {
    // st_abf246e4 — a spawned sub-agent finished. Claude Code fires SubagentStop
    // (not Stop) for sidechain completions, so without this branch a subagent
    // session would never materialize live. The queue handler treats
    // 'subagent-stop' exactly like 'session-stop' (calls materializeSession);
    // origin is decided authoritatively by isSidechain at parse, so the marker
    // only needs to trigger the materialize, not carry provenance.
    await post({
      source: 'claude-code', threadId, role: 'system',
      content: 'subagent-stop',
      summary: 'claude-code subagent ended',
    });
  }
}

main().catch(() => {});
