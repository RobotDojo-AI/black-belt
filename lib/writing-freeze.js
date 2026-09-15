/**
 * Frozen writing blocks. Persist, assemble, Stop-gate.
 * Load is not the switch. Freeze is the switch.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { classifyWriting, inferOwnerSlugs } from './writing-classify.js';
import { generate } from './writing.js';

export const INTELLIGENCE_TIER = 'orchestration';

export const FREEZE_DIR = join(homedir(), 'robotdojo/user/workbenches/user/wk_user/writing-freeze');

export function frozenFence(block) {
  return `<<<FROZEN speaker=${block.speaker} sha256=${block.sha256}>>>\n${block.body}\n<<<END_FROZEN>>>`;
}

export function assembleFrozenText(blocks) {
  return (blocks || []).map((b) => b.body).filter(Boolean).join('\n\n');
}

export function assistantContainsFrozenBody(assistantText, block) {
  const text = String(assistantText || '');
  if (!block?.body) return false;
  return text.includes(block.body);
}

export function freezePath(host, sessionKey) {
  const safeHost = String(host || 'unknown').replace(/[^a-z0-9_-]/gi, '');
  const safeSession = String(sessionKey || 'default').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
  return join(FREEZE_DIR, `${safeHost}-${safeSession}.json`);
}

export function writeFreezeFile(record) {
  const path = freezePath(record.host, record.session_key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2));
  return path;
}

export function readFreezeFile(host, sessionKey) {
  const path = freezePath(host, sessionKey);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function clearFreezeFile(host, sessionKey) {
  const path = freezePath(host, sessionKey);
  try { unlinkSync(path); } catch { /* missing is fine */ }
}

/**
 * Build the frozen blocks for one user turn.
 * Always generates Miyagi. Adds owner block when classifier says draft.
 */
export async function assembleFrozenTurn({
  userText,
  surface = 'web',
  host = 'web',
  sessionKey = 'web',
  extraContext = null,
  getClient,
} = {}) {
  const classified = classifyWriting(userText);
  const blocks = [];
  const miyagiBrief = classified.ownerDraft
    ? 'Speak to the owner in 1-3 short sentences. Do not write the sendable note. No To:/From:/Subject headers. The sendable draft is a separate block.'
    : String(userText);
  const miyagi = await generate({
    speaker: 'miyagi',
    brief: miyagiBrief,
    structure: 'reply',
    formatting: surface === 'web' || surface === 'mobile' ? 'web' : 'coding-agent',
    extraContext: classified.ownerDraft ? String(userText) : extraContext,
    getClient,
  });
  blocks.push(miyagi);

  if (classified.ownerDraft) {
    const slugs = inferOwnerSlugs(userText);
    const owner = await generate({
      speaker: 'owner',
      brief: String(userText),
      structure: slugs.structure,
      formatting: slugs.formatting,
      extraContext,
      getClient,
    });
    blocks.push(owner);
  }

  const record = {
    host,
    session_key: sessionKey,
    turn_fingerprint: createHash('sha256').update(String(userText || '')).digest('hex').slice(0, 16),
    blocks,
    stop_rounds: 0,
    max_stop_rounds: 1,
    status: 'pending',
    classified,
  };
  return record;
}

export async function* streamFrozenTurn(opts) {
  yield { type: 'prelude', text: 'Working on it...' };
  const rec = await assembleFrozenTurn(opts);
  rec.status = 'pending';
  if (opts.persist !== false) writeFreezeFile(rec);
  yield {
    type: 'writing_freeze',
    sha256: rec.blocks.map((b) => b.sha256),
    speakers: rec.blocks.map((b) => b.speaker),
    classified: rec.classified,
  };
  const text = assembleFrozenText(rec.blocks);
  if (!text) throw new Error('generate returned empty assembly');
  yield { type: 'delta', text };
  rec.status = 'satisfied';
  if (opts.persist !== false) writeFreezeFile(rec);
}

export function evaluateStopGate(record, assistantText) {
  if (!record || !Array.isArray(record.blocks) || record.blocks.length === 0) {
    return { decision: 'allow', reason: 'no_freeze' };
  }
  const missing = record.blocks.filter((b) => !assistantContainsFrozenBody(assistantText, b));
  if (missing.length === 0) {
    return { decision: 'allow', reason: 'satisfied', status: 'satisfied' };
  }
  const rounds = Number(record.stop_rounds || 0);
  if (rounds < (record.max_stop_rounds ?? 1)) {
    return {
      decision: 'block',
      reason: 'frozen_body_missing',
      status: 'pending',
      missing: missing.map((b) => b.sha256),
      feed: record.blocks.map(frozenFence).join('\n\n'),
    };
  }
  return {
    decision: 'allow',
    reason: 'failed_incomplete',
    status: 'failed_incomplete',
    missing: missing.map((b) => b.sha256),
  };
}
