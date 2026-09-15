/**
 * Vercel Edge function — POST /api/auth/token at the apex (robotdojo.ai).
 *
 * The apex deployment has no session and no slug context. The Mac's local
 * Hono server is the authority on token validity, reached via the relay
 * tunnel at {server}.robotdojo.ai. This function is a thin auth proxy:
 *
 *   1. Parse {server?, token} from the request body. `server` is a hidden
 *      routing hint, not user-facing login copy; if omitted, use the private
 *      beta default.
 *   2. Rate-limit per IP (5/60s, in-memory per-Edge-instance — same trade-off
 *      as api/feedback.js:45).
 *   3. Outbound fetch https://{server}.robotdojo.ai/api/auth/token with the
 *      token payload, abortable at 5s.
 *   4. On Mac 200: forward Mac's Set-Cookie (already scoped Domain=.robotdojo.ai
 *      by lib/session.js:175) + add an HttpOnly rd_server cookie that the
 *      middleware reads server-side to route subsequent requests to this Mac.
 *      (The login form does not show it; server slug is relay plumbing.)
 *      Return
 *      {ok:true, redirect:"/chat"} (or body.redirect if it's a safe same-origin
 *      path). Path-only redirect is mandatory — middleware.js:5 invariant says
 *      "the subdomain is never visible." A host-changing redirect here would
 *      land the user on the slug subdomain, violating the apex-stays-apex
 *      contract. Fixed by st_cfb2859e (was: host-changing URL).
 *   5. Any error — bad body, bad server format, Mac non-200, Mac throw,
 *      Mac timeout — returns 401 with body {error:"invalid_credentials"}
 *      after a constant-time floor of ≥800 ms. Byte-identical body across
 *      error paths is mandatory for anti-enumeration (01-research.md L275,
 *      OWASP / PortSwigger). The X-Status-Reason response header signals
 *      the failure mode to ops without leaking signal in the body.
 *
 * The slug-subdomain login at {slug}.robotdojo.ai/api/auth/token is
 * unchanged — that path bypasses this function entirely (Vercel middleware
 * runs only at apex). routes/auth.js remains the validator of record.
 *
 * Required env on Vercel: none. SESSION_SECRET is consumed by the Mac, not
 * the apex — the apex just passes the cookie through.
 *
 * Why injectable Mac-fetch (_MAC_FETCH.current):
 *   tests/specs/st_fc3856d6.test.js exercises the function with synthetic
 *   Request objects; the test mocks the outbound Mac call by rebinding
 *   this export. Keeping the seam in the module avoids spinning up a real
 *   HTTPS endpoint for unit tests.
 *
 * Why _resetRateLimit():
 *   In-memory rate-limit state leaks across test cases. The reset helper
 *   is called by the spec's loadModule() at the top of each test.
 */

export const config = { runtime: 'edge' };

// Per-Edge-instance state. Acceptable failure: requests load-balanced
// across isolates evade the cap. Matches api/feedback.js:45-46.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;
let rateMap = new Map();

// Anti-enumeration timing floor. Set above worst-case warm + cold-start
// variance to keep error-path latency uniform. The enumeration probe
// (scripts/qa/probes/apex-login-enumeration-probe.js) verifies the floor
// empirically against production.
const ERROR_FLOOR_MS = 800;

// Outbound timeout for the Mac fetch. The Mac handler returns within
// hundreds of ms on warm sessions. Cold SNI tunnel path (NLB → gateway SNI
// router → tunnel-client WS → Mac TLS) empirically takes 5-6 s when the
// connection is idle — raised from 5 s to 12 s to cover the cold path under
// embedding-load event-loop contention. Single-attempt constraint is preserved
// (see NOTE below); the higher ceiling gives the cold path room to succeed.
//
// NOTE: a bounded retry was considered here to survive a transient Mac
// event-loop freeze, but it was rejected — two attempts widen the
// anti-enumeration timing oracle (a nonexistent/unreachable slug would take
// ~2x as long as a real-slug-wrong-token, which the 800 ms floor does not
// mask). Login timing therefore stays single-attempt, matching the original
// design. Freeze-resilience for the LOGIN path is deferred to Build 2
// (st_27561b77); the in-session session-check retry in middleware.js has no
// enumeration surface and is kept.
const MAC_FETCH_TIMEOUT_MS = 12000;
const MIN_BROWSER_LOGIN_TTL_SECONDS = 60 * 60 * 24 * 30;
const RELAY_ROUTING_TTL_SECONDS = 60 * 60 * 24 * 365;

// Server-name shape — single DNS label, slug alphabet, capped at 40 chars
// to bound the outbound URL length. Same character class enforced for slug
// registration (gateway/lib/tcp-registry.js).
const SERVER_RE = /^[a-z0-9-]{1,40}$/;
const DEFAULT_SERVER = 'dojo';

// Sanitize a client-supplied redirect target. Returns the input if it's a
// non-empty string starting with `/` (and not `//` — protocol-relative attack)
// and not containing `://` (no full URLs). Otherwise returns null.
// st_cfb2859e: defeats redirect-target tampering and enforces the apex-stays-
// apex invariant (middleware.js:5). A non-null return is safe to splat into
// a Location header or Response.body.redirect.
export function sanitizeRedirect(s) {
  if (typeof s !== 'string' || s.length === 0) return null;
  if (!s.startsWith('/')) return null;
  if (s.startsWith('//')) return null;
  if (s.includes('://')) return null;
  return s;
}

// Injectable Mac-fetch seam — see header comment. Wrapped in an object so
// the test can mutate .current after import; reassigning a top-level
// `export let` would not propagate.
export const _MAC_FETCH = { current: (typeof globalThis !== 'undefined' && globalThis.fetch) || fetch };

export function _resetRateLimit() {
  rateMap = new Map();
}

function extractIp(request) {
  // x-forwarded-for is comma-separated; the first value is the client.
  // Vercel sets x-vercel-forwarded-for (trusted) but x-forwarded-for is
  // also populated and matches the spec's test header.
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

// Wait until total elapsed reaches floor. Used on every error path; the
// happy path is unconstrained so successful logins stay fast.
async function enforceTimingFloor(startMs) {
  const remaining = ERROR_FLOOR_MS - (Date.now() - startMs);
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}

// Constructs the canonical error response. Body is byte-identical across
// every error code path (the reason variance lives in headers only).
function errorResponse(latencyMs, reason) {
  return new Response(JSON.stringify({ error: 'invalid_credentials' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'x-status-reason': reason,
      'x-apex-latency-ms': String(latencyMs),
    },
  });
}

function rateLimitResponse(latencyMs) {
  // Rate-limit is a separate status — 429 not 401 — but still emits the
  // X-Status-Reason for ops parity. Body shape distinct from the
  // invalid_credentials response on purpose: 429 is not a credential
  // verdict, so it does not need to be byte-identical with auth failures
  // (an attacker who got here already used 5 attempts and learned nothing
  // about slug existence from any of them).
  return new Response(JSON.stringify({ error: 'rate_limited' }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'x-status-reason': 'rate_limit',
      'x-apex-latency-ms': String(latencyMs),
    },
  });
}

function badRequestResponse(latencyMs, reason) {
  // 400 is reserved for malformed-protocol cases (no body, invalid JSON).
  // These cannot leak slug-existence signal because the request never
  // reached server-name validation. AC 4's VC posts {} and expects 400,
  // which proves the request reached the handler.
  return new Response(JSON.stringify({ error: 'invalid_request' }), {
    status: 400,
    headers: {
      'content-type': 'application/json',
      'x-status-reason': reason,
      'x-apex-latency-ms': String(latencyMs),
    },
  });
}

function reasonForMacNonOk(status) {
  if (status === 400) return 'token_required';
  if (status === 401 || status === 403) return 'wrong_token';
  if (status === 404) return 'login_endpoint_missing';
  if (status >= 500) return 'mac_error';
  return 'mac_rejected';
}

export default async function handler(request) {
  const start = Date.now();

  // 1. Body parse. 400 on empty/malformed — these are protocol errors,
  // not auth failures, so the timing floor does not apply.
  let raw;
  try { raw = await request.text(); }
  catch { return badRequestResponse(Date.now() - start, 'body_read_failed'); }
  if (!raw) return badRequestResponse(Date.now() - start, 'empty_body');

  let body;
  try { body = JSON.parse(raw); }
  catch { return badRequestResponse(Date.now() - start, 'invalid_json'); }
  if (!body || typeof body !== 'object') {
    return badRequestResponse(Date.now() - start, 'invalid_payload');
  }

  // Distinguish "malformed request" from "bad credentials":
  //   - Body present but neither server nor token supplied as strings →
  //     this is a protocol error, not an auth attempt. Return 400 so
  //     callers (and AC 4) can verify the handler is reached without
  //     burning a rate-limit slot or revealing any auth signal.
  //   - Body has at least one of {server, token} as a string → treat as an
  //     auth attempt; downstream format checks return 401 with the canonical
  //     error body so format failures cannot be distinguished from credential
  //     failures. Missing server uses the hidden default route.
  const serverRaw = typeof body.server === 'string' ? body.server : null;
  const tokenRaw = typeof body.token === 'string' ? body.token : null;
  if (serverRaw === null && tokenRaw === null) {
    return badRequestResponse(Date.now() - start, 'missing_fields');
  }

  // 2. Rate limit. Checked before format validation so an attacker who
  // probes a malformed server name many times still hits the per-IP cap.
  const ip = extractIp(request);
  if (!checkAndIncrementRate(ip, Date.now())) {
    return rateLimitResponse(Date.now() - start);
  }

  // 3. Format validation. Bad server format → uniform 401, NOT 400. The
  // spec test 'invalid server format' posts '../../etc/passwd' and
  // expects 401 with the standard error body — treating malformed server
  // as an auth failure preserves anti-enumeration parity (an attacker
  // probing for slug syntax learns the same as one probing wrong tokens).
  const server = serverRaw || DEFAULT_SERVER;
  const token = tokenRaw || '';

  if (!SERVER_RE.test(server) || !token) {
    await enforceTimingFloor(start);
    return errorResponse(Date.now() - start, 'invalid_format');
  }

  // 4. Outbound Mac fetch. The Mac handler is responsible for token
  // validity; we proxy verbatim and forward its Set-Cookie.
  const macUrl = `https://${server}.robotdojo.ai/api/auth/token`;
  let macRes;
  try {
    macRes = await _MAC_FETCH.current(macUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(MAC_FETCH_TIMEOUT_MS),
    });
  } catch {
    // Mac unreachable — connection refused, DNS failure, timeout, etc.
    // Uniform 401 + timing floor preserves anti-enumeration parity:
    // an attacker probing nonexistent slugs gets the same response as
    // someone with a wrong token for a real slug.
    await enforceTimingFloor(start);
    return errorResponse(Date.now() - start, 'mac_unreachable');
  }

  if (macRes.status === 409) {
    await enforceTimingFloor(start);
    return new Response(JSON.stringify({ error: 'not_initialized' }), {
      status: 409,
      headers: {
        'content-type': 'application/json',
        'x-status-reason': 'not_initialized',
        'x-apex-latency-ms': String(Date.now() - start),
      },
    });
  }

  if (macRes.status !== 200) {
    // Mac said no. Uniform 401 to the caller regardless of what the Mac
    // returned — the body is identical to the mac_unreachable path so
    // timing + body together leak nothing. The diagnostic header keeps
    // owner-facing Connect from blaming every local failure on the token.
    await enforceTimingFloor(start);
    return errorResponse(Date.now() - start, reasonForMacNonOk(macRes.status));
  }

  // 5. Happy path. Forward Mac's Set-Cookie (Domain=.robotdojo.ai already
  // set by lib/session.js#cookieOptions) and append our rd_server cookie
  // so the form prefills on return visits. The redirect is path-only —
  // sanitizeRedirect strips any host/scheme; the cookie scope handles
  // apex+subdomain transparency via Vercel middleware (middleware.js:5).
  const safeRedirect = sanitizeRedirect(body.redirect) || '/chat';
  const headers = new Headers({ 'content-type': 'application/json' });

  // Forward every Set-Cookie header verbatim. Node 18+ exposes
  // getSetCookie(); fall back to .get() (single value) for older runtimes.
  const macCookies = typeof macRes.headers.getSetCookie === 'function'
    ? macRes.headers.getSetCookie()
    : (macRes.headers.get('set-cookie') ? [macRes.headers.get('set-cookie')] : []);
  for (const cookie of macCookies) {
    headers.append('set-cookie', cookie);
  }

  // rd_server records which Mac to relay to. It is hidden plumbing, so it is
  // NOT surfaced to page JS: HttpOnly is set. Middleware reads this cookie
  // server-side (raw Cookie header) for routing only. Max-Age one year keeps
  // routing stable across sessions without exposing the slug in normal URLs.
  if (RELAY_ROUTING_TTL_SECONDS < MIN_BROWSER_LOGIN_TTL_SECONDS) {
    throw new Error('rd_server ttl must be at least 30 days');
  }
  headers.append(
    'set-cookie',
    `rd_server=${server}; Domain=.robotdojo.ai; Max-Age=${RELAY_ROUTING_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax; Secure`,
  );

  headers.set('x-apex-latency-ms', String(Date.now() - start));

  return new Response(
    JSON.stringify({ ok: true, redirect: safeRedirect }),
    { status: 200, headers },
  );
}
