/**
 * Vercel Edge function — POST /api/feedback
 *
 * Single public endpoint for error reports and feature requests from any
 * Robot Dojo install. Creates an Asana task in the owner's "robotdojo"
 * project using a Vercel-side ASANA_PAT env var (never shipped to user
 * installs).
 *
 * Body contract (st_d9fc573b 02-design.md L467-532):
 *   {
 *     kind: 'error_report' | 'feature_request',
 *     description: string (required),
 *     email?: string,
 *     url?: string,
 *     userAgent?: string,
 *     recentErrors?: [{message, filename, lineno, ts}]
 *   }
 *
 * Responses:
 *   202 — accepted (Asana create is fire-and-forget)
 *   400 — { error: 'invalid_payload' }
 *   413 — { error: 'payload_too_large' } (>32 KB body)
 *   429 — { error: 'rate_limited' } (>50/hr per IP)
 *
 * Asana task naming:
 *   error_report     → "[BUG] <first 80 chars of description>"
 *   feature_request  → "[FEAT] <first 80 chars of description>"
 *
 * Rate limit: in-memory per-process Map<ip, {count, windowStart}>, 1-hour rolling
 * window. Vercel Edge instances are ephemeral — this underestimates across
 * instances but is sufficient as abuse protection at this scale without a
 * Redis dependency.
 *
 * Edge runtime chosen to match `api/public-chat.js`.
 * Asana create is a plain `fetch()` — no macOS Keychain shell-out needed.
 */

export const config = { runtime: 'edge' };

// PROJECT_GID is sourced from a Vercel env var, NOT a tracked literal. This is a
// Vercel Edge function (V8 isolate — no `node:fs`), so it cannot read
// config/asana-routing.json the way the Node consumers do; the owner sets
// ASANA_PROJECT_GID in the Vercel dashboard alongside ASANA_PAT (both are
// server-side only, never shipped to installs). Unset (e.g. a fresh fork) →
// createAsanaTask logs and skips, so the endpoint still returns 202 and never
// crashes. Kept out of tracked source so no owner-account gid ships publicly
// (enforced by scripts/check-public-config-clean.js).
const MAX_BODY_BYTES = 32 * 1024;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 50;

// In-memory rate-limit map (per Edge instance).
const rateMap = new Map();

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function emptyResponse(status) {
  return new Response('', {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function extractIp(request) {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('x-real-ip') || 'unknown';
}

function checkAndIncrementRate(ip, now) {
  const entry = rateMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    rateMap.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_MAX) return false;
  entry.count++;
  return true;
}

function isValidDescription(s) {
  return typeof s === 'string' && s.trim().length >= 10;
}

function buildTaskName(kind, description) {
  const prefix = kind === 'error_report' ? '[BUG]' : '[FEAT]';
  const head = description.replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${prefix} ${head}`;
}

function buildTaskNotes(body) {
  const parts = [
    `Kind: ${body.kind}`,
    `Description:\n${body.description}`,
  ];
  if (body.name) parts.push(`Name: ${body.name}`);
  if (body.email) parts.push(`Email: ${body.email}`);
  if (body.source) parts.push(`Source: ${body.source}`);
  if (body.url) parts.push(`URL: ${body.url}`);
  if (body.userAgent) parts.push(`User-Agent: ${body.userAgent}`);
  if (typeof body.includeTelemetry === 'boolean') parts.push(`Telemetry approved: ${body.includeTelemetry ? 'yes' : 'no'}`);
  if (typeof body.includeChatHistory === 'boolean') parts.push(`Chat history approved: ${body.includeChatHistory ? 'yes' : 'no'}`);
  if (Array.isArray(body.recentErrors) && body.recentErrors.length > 0) {
    const lines = body.recentErrors
      .slice(0, 20)
      .map((e) => `  - ${e?.message || ''} (${e?.filename || ''}:${e?.lineno || ''})`)
      .join('\n');
    parts.push(`Recent errors:\n${lines}`);
  }
  if (Array.isArray(body.chatHistory) && body.chatHistory.length > 0) {
    const lines = body.chatHistory.slice(0, 8).map((text, i) => `--- message ${i + 1} ---\n${String(text).slice(0, 1200)}`).join('\n\n');
    parts.push(`Recent chat history:\n${lines}`);
  }
  parts.push(`Submitted: ${new Date().toISOString()}`);
  return parts.join('\n\n');
}

async function createAsanaTask(name, notes) {
  const pat = process.env.ASANA_PAT;
  const projectGid = process.env.ASANA_PROJECT_GID;
  if (!pat || !projectGid) {
    console.error('[feedback] ASANA_PAT or ASANA_PROJECT_GID env var missing — task not created');
    return;
  }
  try {
    const res = await fetch('https://app.asana.com/api/1.0/tasks', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pat}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data: { name, notes, projects: [projectGid] } }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[feedback] Asana ${res.status}: ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.error('[feedback] Asana fetch threw:', err?.message || err);
  }
}

export default async function handler(request, context) {
  try {
    if (request.method === 'OPTIONS') return emptyResponse(204);
    if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);

    // Pre-flight content-length guard (cheap rejection before body parse).
    const contentLength = parseInt(request.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BODY_BYTES) return jsonResponse({ error: 'payload_too_large' }, 413);

    // IP-based rate limit.
    const ip = extractIp(request);
    if (!checkAndIncrementRate(ip, Date.now())) {
      return jsonResponse({ error: 'rate_limited' }, 429);
    }

    // Read raw text so we can re-check size after stream completes.
    let raw;
    try { raw = await request.text(); }
    catch { return jsonResponse({ error: 'invalid_json' }, 400); }
    if (raw && new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return jsonResponse({ error: 'payload_too_large' }, 413);
    }

    let body;
    try { body = JSON.parse(raw || '{}'); }
    catch { return jsonResponse({ error: 'invalid_json' }, 400); }

    // Payload validation.
    if (body?.kind !== 'error_report' && body?.kind !== 'feature_request') {
      return jsonResponse({ error: 'invalid_payload' }, 400);
    }
    if (!isValidDescription(body?.description)) {
      return jsonResponse({ error: 'invalid_payload' }, 400);
    }

    // Fire-and-forget Asana create — do not block the 202 on Asana latency.
    // Edge runtime kills detached promises when the Response returns, so a
    // bare promise.catch() is not enough. context.waitUntil() is the only
    // reliable way to keep the fetch alive past Response — the second
    // handler arg is required for this on Vercel Edge.
    const name = buildTaskName(body.kind, body.description);
    const notes = buildTaskNotes(body);
    const promise = createAsanaTask(name, notes);
    if (context && typeof context.waitUntil === 'function') {
      context.waitUntil(promise);
    } else {
      promise.catch(() => {});
    }

    return emptyResponse(202);
  } catch (err) {
    console.error('[feedback] top-level crash:', err?.stack || err?.message || err);
    return jsonResponse({ error: 'internal_error' }, 500);
  }
}
