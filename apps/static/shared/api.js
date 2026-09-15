// Auth and fetch wrapper — loaded after utils.js
// Remote detection: when accessed via robotdojo.ai, route API calls through tunnel
const _IS_REMOTE = !location.hostname.includes('localhost') && !location.hostname.includes('127.0.0.1') && !location.hostname.includes('.ts.net') && !location.hostname.startsWith('100.');
// Tunnel URL is injected by the server at render time via
// <meta name="tunnel-url" content="..."> (sourced from config.tunnel.url /
// ROBOTDOJO_TUNNEL_URL). Absent or empty = route through same origin, which
// is correct for most installs. No hard-coded tunnel hostnames.
//
// Proxy prefix (public-URL installs): when this page loads from
// robotdojo.ai/me/<slug>/<app>, every /api/* fetch must ALSO be sent under
// /me/<slug>/ so the Vercel edge middleware proxies it through the relay
// to the user's Mac. Without this prefix, /api/* calls would hit Vercel
// static hosting and 404. Detected from location.pathname; on local or
// Tailscale installs the match fails and _PROXY_PREFIX stays empty so
// behaviour is unchanged.
// On subdomain installs ({slug}.robotdojo.ai), the origin IS the Mac — no prefix needed.
// On legacy /me/{slug}/ paths, extract the prefix for backward compat.
const _SUBDOMAIN_MATCH = location.hostname.match(/^([a-z0-9-]+)\.robotdojo\.ai$/);
const _PROXY_PREFIX_MATCH = !_SUBDOMAIN_MATCH && location.pathname.match(/^\/me\/[^/]+/);
const _PROXY_PREFIX = _PROXY_PREFIX_MATCH ? _PROXY_PREFIX_MATCH[0] : '';
const _TUNNEL_META = document.querySelector('meta[name="tunnel-url"]');
const _TUNNEL_URL = (_TUNNEL_META && _TUNNEL_META.content)
  || (window.location.origin + _PROXY_PREFIX);
function _resolveUrl(url) {
  if (!_IS_REMOTE || typeof url !== 'string') return url;
  if (url.startsWith('/api/') || url.startsWith('/auth/')) return _TUNNEL_URL + url;
  return url;
}

const getToken = () => localStorage.getItem('robotdojo_token');
const setToken = t => localStorage.setItem('robotdojo_token', t);
const _fetch = window.fetch;
window.fetch = function(url, opts = {}) {
  const resolved = _resolveUrl(url);
  const t = getToken();
  if (t && typeof resolved === 'string' && (resolved.includes('/api/') || resolved.includes('/auth/'))) {
    opts.headers = opts.headers || {};
    if (opts.headers instanceof Headers) opts.headers.set('Authorization', 'Bearer ' + t);
    else opts.headers['Authorization'] = 'Bearer ' + t;
  }
  return _fetch.call(this, resolved, opts);
};

// Warmup: fire only where private APIs resolve to a local/claimed server.
// On the public root domain, a stale localStorage token must not make public
// pages call private warmup endpoints and leak failed-resource noise into QA.
const _CAN_WARM_PRIVATE_API = !_IS_REMOTE || !!_SUBDOMAIN_MATCH || !!_PROXY_PREFIX;
if (_CAN_WARM_PRIVATE_API && getToken()) {
  window._warmReady = fetch('/api/warm').then(() => true).catch(() => true);
} else {
  window._warmReady = Promise.resolve(true);
}

function showLogin(msg) {
  // When running under a cookie-session (remote / magic-link) there is no
  // Bearer token to paste — send the user to the proper magic-link flow and
  // carry the current path forward so they land back here after sign-in.
  // The Bearer-token fallback only makes sense for direct-localhost dev.
  const isRemote = !location.hostname.includes('localhost')
    && !location.hostname.includes('127.0.0.1')
    && !location.hostname.includes('.ts.net')
    && !location.hostname.startsWith('100.');
  if (isRemote) {
    if (msg) { try { sessionStorage.setItem('robotdojo_login_flash', msg); } catch {} }
    const here = location.pathname + location.search + location.hash;
    location.href = '/login?redirect=' + encodeURIComponent(here);
    return;
  }
  document.body.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100dvh;background:var(--bg)"><div style="text-align:center;max-width:360px;padding:20px"><div style="font-family:'Noto Sans JP';font-size:48px;opacity:0.4;margin-bottom:16px">道場</div><h2 style="font-weight:500;margin-bottom:8px">Robot Dojo</h2>${msg ? '<p style="color:var(--red);font-size:13px;margin-bottom:12px">' + msg + '</p>' : ''}<p style="color:var(--text-dim);font-size:13px;margin-bottom:16px">Paste your local access token to continue.</p><input id="loginToken" type="password" placeholder="Local access token" style="width:100%;padding:12px 16px;border:1px solid var(--border);border-radius:12px;font-size:15px;outline:none;margin-bottom:12px;background:var(--bg2);color:var(--text)"><button onclick="tryLogin()" style="width:100%;padding:12px;background:var(--accent);color:#fff;border:none;border-radius:12px;font-size:15px;cursor:pointer">Connect</button></div></div>`;
  document.body.classList.add('app-ready');
  setTimeout(() => { const el = $('#loginToken'); if (el) { el.focus(); el.onkeydown = e => { if (e.key === 'Enter') tryLogin(); }; } }, 50);
}
async function tryLogin() {
  const t = $('#loginToken')?.value?.trim();
  if (!t) return;
  setToken(t);
  const resp = await fetch('/api/whoami');
  if (resp.status === 401 || resp.status === 403) { localStorage.removeItem('robotdojo_token'); showLogin('Invalid token'); }
  else location.reload();
}
