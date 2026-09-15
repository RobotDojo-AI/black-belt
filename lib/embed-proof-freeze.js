import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TTL_MS = 10 * 60_000;

export function embedProofFreezeRequestFile() {
  return process.env.ROBOTDOJO_EMBED_PROOF_FREEZE_REQUEST_FILE
    || path.join(os.homedir(), '.robotdojo', 'runtime', 'embed-proof-freeze-request.json');
}

export function embedProofFreezeStatusFile() {
  return process.env.ROBOTDOJO_EMBED_PROOF_FREEZE_STATUS_FILE
    || path.join(os.homedir(), '.robotdojo', 'runtime', 'embed-proof-freeze-status.json');
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function publicRequestSnapshot(request) {
  if (!request || typeof request !== 'object') return null;
  const { token, ...rest } = request;
  return rest;
}

export function readEmbedProofFreezeRequest({ now = Date.now() } = {}) {
  const file = embedProofFreezeRequestFile();
  try {
    const request = readJson(file);
    const expiresAt = Number(request.expires_at) || 0;
    if (expiresAt > now) {
      return {
        active: true,
        reason: request.reason || 'embed_proof_freeze_requested',
        file,
        id: request.id || null,
        token: request.token || null,
        request,
      };
    }
    try { fs.unlinkSync(file); } catch {}
    return {
      active: false,
      reason: 'embed_proof_freeze_expired',
      file,
      id: request.id || null,
      request: publicRequestSnapshot(request),
    };
  } catch (err) {
    return {
      active: false,
      reason: err?.code === 'ENOENT' ? 'embed_proof_freeze_missing' : 'embed_proof_freeze_unreadable',
      file,
      error: err?.code || err?.message || String(err),
    };
  }
}

export function beginEmbedProofFreezeRequest({
  reason = 'exact_ann_proof',
  ttlMs = DEFAULT_TTL_MS,
  metadata = {},
} = {}) {
  const now = Date.now();
  const current = readEmbedProofFreezeRequest({ now });
  const file = embedProofFreezeRequestFile();
  if (current.active) {
    return {
      ok: false,
      reason: 'embed_proof_freeze_conflict',
      file,
      current_reason: current.reason,
      current_request: publicRequestSnapshot(current.request),
    };
  }

  const request = {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    reason,
    created_at: now,
    expires_at: now + Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS),
    ttl_ms: Math.max(1_000, Number(ttlMs) || DEFAULT_TTL_MS),
    pid: process.pid,
    metadata,
  };
  atomicWriteJson(file, request);
  return {
    ok: true,
    reason: 'embed_proof_freeze_requested',
    file,
    id: request.id,
    token: request.token,
    request,
  };
}

export function releaseEmbedProofFreezeRequest(freeze) {
  const file = embedProofFreezeRequestFile();
  const expectedToken = freeze?.token || freeze?.request?.token || null;
  if (!expectedToken) {
    return { ok: true, skipped: true, reason: 'embed_proof_freeze_no_token', file };
  }
  try {
    const current = readJson(file);
    if (current.token !== expectedToken) {
      return {
        ok: true,
        skipped: true,
        reason: 'embed_proof_freeze_changed',
        file,
        expected_id: freeze?.id || freeze?.request?.id || null,
        current_id: current.id || null,
      };
    }
    fs.unlinkSync(file);
    return { ok: true, reason: 'embed_proof_freeze_released', file, id: current.id || null };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return { ok: true, skipped: true, reason: 'embed_proof_freeze_missing_on_release', file };
    }
    return {
      ok: false,
      reason: 'embed_proof_freeze_release_failed',
      file,
      error: err?.message || String(err),
    };
  }
}

export function writeEmbedProofFreezeStatus(requestState, {
  topic,
  pending,
  embedded,
  metadata = {},
} = {}) {
  const request = requestState?.request || requestState || {};
  const status = {
    id: request.id || requestState?.id || null,
    active: true,
    reason: 'embed_proof_freeze_active',
    request_reason: request.reason || requestState?.reason || null,
    pid: process.pid,
    topic: topic || null,
    pending: Number.isFinite(Number(pending)) ? Number(pending) : null,
    embedded: Number.isFinite(Number(embedded)) ? Number(embedded) : null,
    parked_at: Date.now(),
    metadata,
  };
  const file = embedProofFreezeStatusFile();
  atomicWriteJson(file, status);
  return { ok: true, reason: 'embed_proof_freeze_status_written', file, status };
}

export function readEmbedProofFreezeStatus() {
  const file = embedProofFreezeStatusFile();
  try {
    return { ok: true, active: true, file, status: readJson(file) };
  } catch (err) {
    return {
      ok: false,
      active: false,
      file,
      reason: err?.code === 'ENOENT' ? 'embed_proof_freeze_status_missing' : 'embed_proof_freeze_status_unreadable',
      error: err?.code || err?.message || String(err),
    };
  }
}

export function clearEmbedProofFreezeStatus({ id = null, pid = process.pid } = {}) {
  const file = embedProofFreezeStatusFile();
  try {
    const current = readJson(file);
    if (id && current.id !== id) {
      return { ok: true, skipped: true, reason: 'embed_proof_freeze_status_changed', file };
    }
    if (pid && current.pid && current.pid !== pid) {
      return { ok: true, skipped: true, reason: 'embed_proof_freeze_status_owned_elsewhere', file };
    }
    fs.unlinkSync(file);
    return { ok: true, reason: 'embed_proof_freeze_status_cleared', file };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, skipped: true, reason: 'embed_proof_freeze_status_missing', file };
    return { ok: false, reason: 'embed_proof_freeze_status_clear_failed', file, error: err?.message || String(err) };
  }
}
