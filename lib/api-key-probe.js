/**
 * lib/api-key-probe.js — zero-cost live handshake for API-key / token providers.
 *
 * INTELLIGENCE_TIER: extraction — deterministic, no LLM inference.
 * COMPUTE TIER: Tier 0 — a plain HTTPS GET against a cheap read-only endpoint
 * (model listing for the LLM providers; a `who am I` route for the token
 * integrations). Never a billable inference call; used both by the manual
 * `POST /api/accounts/keys/test` route (Thin Facade: the route delegates here)
 * and by the 15-minute cadence handshake in lib/integration-health.js. Never on
 * a chat/render path.
 *
 * Covers the model keys (anthropic, openai, google[-ai], xai) AND the token
 * integrations whose Healthy dot must be earned by a live check, not mere key
 * presence (oura, notion, asana / asana_secondary — st_bf4978b0 QA-fix: these were
 * false-red because their old probes only checked token presence).
 *
 * Returns a normalized status so every caller classifies identically:
 *   valid          — HTTP 200, the key works (a real live verification)
 *   invalid_key    — HTTP 401/403, the key is rejected
 *   quota_exceeded — HTTP 429, the provider is throttling the key
 *   provider_error — any other HTTP status, a network error, or a timeout
 */

// Provider → zero-cost liveness probe. Keyed by the normalized provider slug the
// route/health layer already uses. Adding a provider = one entry.
function probeDescriptor(provider, key) {
  switch (provider) {
    case 'anthropic':
      return { url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
    case 'openai':
      return { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } };
    case 'google':
    case 'google-ai':
      return { url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, headers: {} };
    case 'xai':
      return { url: 'https://api.x.ai/v1/models', headers: { Authorization: `Bearer ${key}` } };
    case 'brave':
      return { url: 'https://api.search.brave.com/res/v1/web/search?q=robotdojo&count=1', headers: { 'X-Subscription-Token': key, Accept: 'application/json' } };
    // Token integrations — cheap read-only identity endpoints (a 200 proves the
    // token is live right now). asana and asana_secondary share Asana's endpoint; the
    // caller passes provider 'asana' with whichever token it is verifying.
    case 'oura':
      return { url: 'https://api.ouraring.com/v2/usercollection/personal_info', headers: { Authorization: `Bearer ${key}` } };
    case 'notion':
      return { url: 'https://api.notion.com/v1/users/me', headers: { Authorization: `Bearer ${key}`, 'Notion-Version': '2022-06-28' } };
    case 'asana':
      return { url: 'https://app.asana.com/api/1.0/users/me', headers: { Authorization: `Bearer ${key}` } };
    default:
      return null;
  }
}

/** Providers that have a zero-cost live probe. Callers use this to decide
 * whether a live handshake is possible (vs. presence-only). */
export function hasLiveProbe(provider) {
  return !!probeDescriptor(provider, 'x');
}

/**
 * Run the live handshake for a provider key.
 * @param {string} provider normalized provider slug
 * @param {string} key the API key
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{status:'valid'|'invalid_key'|'quota_exceeded'|'provider_error', httpStatus:number|null, error:string|null}>}
 */
export async function probeApiKeyLive(provider, key, { timeoutMs = 8000 } = {}) {
  const probe = probeDescriptor(provider, key);
  if (!probe) return { status: 'provider_error', httpStatus: null, error: `no live probe for ${provider}` };
  if (!key) return { status: 'invalid_key', httpStatus: null, error: 'missing key' };

  let httpStatus;
  try {
    const res = await fetch(probe.url, { signal: AbortSignal.timeout(timeoutMs), headers: probe.headers });
    httpStatus = res.status;
  } catch {
    return { status: 'provider_error', httpStatus: null, error: 'provider probe failed or timed out' };
  }

  if (httpStatus === 200) return { status: 'valid', httpStatus, error: null };
  if (httpStatus === 401 || httpStatus === 403) return { status: 'invalid_key', httpStatus, error: 'invalid API key' };
  if (httpStatus === 429) return { status: 'quota_exceeded', httpStatus, error: 'provider quota exceeded' };
  return { status: 'provider_error', httpStatus, error: `provider probe returned HTTP ${httpStatus}` };
}
