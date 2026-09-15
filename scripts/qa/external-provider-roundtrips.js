#!/usr/bin/env node
/**
 * Read-only external provider roundtrips.
 *
 * This intentionally calls the providers directly instead of trusting local
 * integration-card state. It never prints secrets or raw provider payloads.
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { fileURLToPath } from 'node:url';
import { readKeychainSecret } from '../../lib/keychain.js';
import { getValidAccessToken, listConnectedGoogleAccounts } from '../../lib/google-oauth.js';
import {
  getClientCredentialsToken,
  getMicrosoftAppRoles,
  getValidMicrosoftAccessToken,
  listConnectedMicrosoftAccounts,
  microsoftRolesSupport,
} from '../../lib/microsoft-oauth.js';

const TIMEOUT_MS = Number(process.env.ROBOTDOJO_PROVIDER_PROBE_TIMEOUT_MS || 15000);
const INCLUDE_NON_LAUNCH = process.argv.includes('--all');
const INCLUDE_ACCOUNT_PAGE_PROVIDERS = process.argv.includes('--account-page') || process.argv.includes('--launch-sheet');
const results = [];

function maskId(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.includes('@')) {
    const [left, domain] = s.split('@');
    return `${left.slice(0, 2)}…@${domain}`;
  }
  return s.length <= 8 ? 'configured' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function secret(...names) {
  for (const name of names) {
    const envName = String(name).replace(/^robotdojo-/, '').replace(/-/g, '_').toUpperCase();
    const env = process.env[envName];
    if (env) return { value: env, name };
    const value = readKeychainSecret(name);
    if (value) return { value, name };
  }
  return null;
}

async function httpJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(opts.timeout || TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* provider returned non-JSON */ }
  if (!res.ok) {
    const code = json?.error?.code || json?.error?.type || json?.errors?.[0]?.message || json?.message || res.statusText;
    throw new Error(`HTTP ${res.status}${code ? ` ${String(code).slice(0, 80)}` : ''}`);
  }
  return json;
}

export function buildGoDaddyAuthorization(apiKey, apiSecret = null) {
  const raw = String(apiKey || '').trim();
  if (/^sso-key\s/i.test(raw)) return raw;
  return `sso-key ${apiSecret && !raw.includes(':') ? `${raw}:${apiSecret}` : raw}`;
}

export function classifyGooglePhotosProbeError(err) {
  if (/HTTP 403|insufficient|PERMISSION_DENIED|scope/i.test(String(err?.message || err))) {
    return {
      skip: true,
      reason: 'Google Photos Library API now limits mediaItems.list to app-created data; current OAuth grant needs appcreateddata or Picker migration',
      scope_design: 'photoslibrary_app_created_data_required',
    };
  }
  return { skip: false };
}

export function shouldProbeOptionalProvider(provider, {
  includeAll = INCLUDE_NON_LAUNCH,
  includeAccountPage = INCLUDE_ACCOUNT_PAGE_PROVIDERS,
} = {}) {
  if (includeAll) return true;
  if (!includeAccountPage) return false;
  return new Set(['xai', 'brave']).has(String(provider || '').toLowerCase());
}

async function run(name, fn) {
  const started = Date.now();
  try {
    const meta = await fn();
    results.push({ name, status: 'pass', ms: Date.now() - started, ...(meta || {}) });
  } catch (err) {
    if (err?.skip) {
      results.push({ name, status: 'skip', ms: Date.now() - started, reason: String(err.message || err).slice(0, 180), ...(err.meta || {}) });
      return;
    }
    results.push({ name, status: 'fail', ms: Date.now() - started, error: String(err?.message || err).slice(0, 180) });
  }
}

async function skip(name, reason) {
  results.push({ name, status: 'skip', reason });
}

function skipError(message, meta = {}) {
  const err = new Error(message);
  err.skip = true;
  err.meta = meta;
  return err;
}

async function requireSecret(name, secretNames, fn) {
  const found = secret(...secretNames);
  if (!found) return skip(name, `missing ${secretNames.join(' or ')}`);
  return run(name, () => fn(found.value, found.name));
}

async function probeGoogleOAuth() {
  const accounts = listConnectedGoogleAccounts();
  if (!accounts.length) return skip('google_oauth', 'no connected Google OAuth account');
  for (const email of accounts) {
    await run(`google_oauth:${maskId(email)}:gmail`, async () => {
      const token = await getValidAccessToken(email);
      if (!token) throw new Error('missing access token');
      await httpJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${token}` },
      });
    });
    await run(`google_oauth:${maskId(email)}:calendar`, async () => {
      const token = await getValidAccessToken(email);
      if (!token) throw new Error('missing access token');
      await httpJson('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1', {
        headers: { Authorization: `Bearer ${token}` },
      });
    });
    await run(`google_oauth:${maskId(email)}:drive`, async () => {
      const token = await getValidAccessToken(email);
      if (!token) throw new Error('missing access token');
      await httpJson('https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id%2Cname%2CmimeType)', {
        headers: { Authorization: `Bearer ${token}` },
      });
    });
    await run(`google_oauth:${maskId(email)}:contacts`, async () => {
      const token = await getValidAccessToken(email);
      if (!token) throw new Error('missing access token');
      await httpJson('https://people.googleapis.com/v1/people/me/connections?pageSize=1&personFields=names,emailAddresses', {
        headers: { Authorization: `Bearer ${token}` },
      });
    });
    await run(`google_oauth:${maskId(email)}:photos`, async () => {
      const token = await getValidAccessToken(email);
      if (!token) throw new Error('missing access token');
      try {
        await httpJson('https://photoslibrary.googleapis.com/v1/mediaItems?pageSize=1', {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        const classified = classifyGooglePhotosProbeError(err);
        if (classified.skip) throw skipError(classified.reason, { scope_design: classified.scope_design });
        throw err;
      }
    });
  }
}

async function probeMicrosoftGraph() {
  const probeMailbox = process.env.MICROSOFT_PROBE_MAILBOX
    || process.env.MICROSOFT_MAILBOX
    || process.env.MICROSOFT_MAILBOX_EMAIL
    || secret('MICROSOFT_MAILBOX_EMAIL')?.value;
  const accounts = [...new Set([
    ...listConnectedMicrosoftAccounts(),
    ...(probeMailbox ? [probeMailbox] : []),
  ].filter(Boolean))];
  if (!accounts.length) {
    const tenant = secret('MICROSOFT_TENANT_ID');
    const clientId = secret('MICROSOFT_CLIENT_ID');
    const clientSecret = secret('MICROSOFT_CLIENT_SECRET');
    if (!tenant || !clientId || !clientSecret) return skip('microsoft_graph:app_credentials', 'missing Microsoft app credentials');
    return run('microsoft_graph:app_credentials', async () => {
      const token = await getClientCredentialsToken();
      const roles = await getMicrosoftAppRoles();
      const support = microsoftRolesSupport(roles);
      if (!support.mail) throw new Error('missing Mail.Read or Mail.ReadWrite application role');
      return { roles: roles.sort(), mailbox: 'not_configured' };
    });
  }
  for (const email of accounts) {
    await run(`microsoft_graph:${maskId(email)}:app_roles`, async () => {
      const token = await getValidMicrosoftAccessToken(email);
      const roles = await getMicrosoftAppRoles();
      const support = microsoftRolesSupport(roles);
      if (!support.mail) throw new Error('missing Mail.Read or Mail.ReadWrite application role');
      return { roles: roles.sort(), calendar: support.calendar };
    });
    await run(`microsoft_graph:${maskId(email)}:mail`, async () => {
      const token = await getValidMicrosoftAccessToken(email);
      await httpJson(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/messages?$top=1&$select=id`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    });
    await run(`microsoft_graph:${maskId(email)}:calendar`, async () => {
      const token = await getValidMicrosoftAccessToken(email);
      await httpJson(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/calendar/events?$top=1&$select=id`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    });
  }
}

async function probeIproyal(proxyValue) {
  const raw = String(proxyValue || '').trim();
  let uri = raw;
  if (!/^[a-z]+:\/\//i.test(uri)) {
    const parts = uri.split(':');
    if (parts.length >= 4) {
      const [host, port, user, pass] = parts;
      uri = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    } else {
      uri = `http://${uri}`;
    }
  }
  const agent = new ProxyAgent(uri);
  const res = await undiciFetch('https://api.ipify.org?format=json', {
    dispatcher: agent,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.json();
}

async function main() {
  await probeGoogleOAuth();
  await probeMicrosoftGraph();

  await requireSecret('anthropic', ['ANTHROPIC_API_KEY'], async (key) => {
    await httpJson('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
  });
  await requireSecret('openai', ['OPENAI_API_KEY'], async (key) => {
    await httpJson('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });
  });
  await requireSecret('google_ai', ['GOOGLE_AI_API_KEY', 'GOOGLE_API_KEY'], async (key) => {
    await httpJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
  });

  await requireSecret('asana:primary', ['ASANA_PAT'], async (key) => {
    await httpJson('https://app.asana.com/api/1.0/users/me', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
  });
  await requireSecret('asana:secondary', ['ASANA_PAT_SECONDARY'], async (key) => {
    await httpJson('https://app.asana.com/api/1.0/users/me', {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    });
  });
  await requireSecret('notion', ['NOTION_TOKEN', 'NOTION_API_KEY'], async (key) => {
    await httpJson('https://api.notion.com/v1/users/me', {
      headers: { Authorization: `Bearer ${key}`, 'Notion-Version': '2022-06-28' },
    });
  });
  await requireSecret('oura', ['OURA_PAT', 'OURA_CLIENT_SECRET'], async (key, name) => {
    await httpJson('https://api.ouraring.com/v2/usercollection/personal_info', {
      headers: { Authorization: `Bearer ${key}` },
    });
    return { credential: name === 'OURA_PAT' || name === 'robotdojo-OURA_PAT' ? 'canonical' : 'legacy_or_wrong_name' };
  });

  if (INCLUDE_NON_LAUNCH || INCLUDE_ACCOUNT_PAGE_PROVIDERS) {
    const shouldProbe = (provider) => shouldProbeOptionalProvider(provider);

    if (shouldProbe('xai')) {
    await requireSecret('xai', ['GROK_API_KEY', 'XAI_API_KEY'], async (key) => {
      await httpJson('https://api.x.ai/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
    });
    }
    if (shouldProbe('mistral')) {
    await requireSecret('mistral', ['MISTRAL_API_KEY'], async (key) => {
      await httpJson('https://api.mistral.ai/v1/models', {
        headers: { Authorization: `Bearer ${key}` },
      });
    });
    }
    if (shouldProbe('elevenlabs')) {
    await requireSecret('elevenlabs', ['ELEVENLABS_API_KEY'], async (key) => {
      await httpJson('https://api.elevenlabs.io/v1/user/subscription', {
        headers: { 'xi-api-key': key },
      });
    });
    }
    if (shouldProbe('stripe')) {
    await requireSecret('stripe', ['STRIPE_SECRET_KEY'], async (key) => {
      await httpJson('https://api.stripe.com/v1/account', {
        headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}` },
      });
    });
    }
    if (shouldProbe('telegram')) {
    await requireSecret('telegram', ['TELEGRAM_BOT_TOKEN'], async (key) => {
      await httpJson(`https://api.telegram.org/bot${key}/getMe`);
    });
    }
    if (shouldProbe('figma')) {
    await requireSecret('figma', ['FIGMA_PAT'], async (key) => {
      await httpJson('https://api.figma.com/v1/me', {
        headers: { 'X-Figma-Token': key },
      });
    });
    }
    if (shouldProbe('brave')) {
    await requireSecret('brave', ['BRAVE_API_KEY'], async (key) => {
      await httpJson('https://api.search.brave.com/res/v1/web/search?q=robotdojo&count=1&text_decorations=false', {
        headers: { Accept: 'application/json', 'X-Subscription-Token': key },
      });
    });
    }
    if (shouldProbe('godaddy')) {
    await requireSecret('godaddy', ['GODADDY_API_KEY'], async (key) => {
      const pairedSecret = secret('GODADDY_API_SECRET', 'GODADDY_SECRET', 'GODADDY_API_KEY_SECRET')?.value;
      const authorization = buildGoDaddyAuthorization(key, pairedSecret);
      await httpJson('https://api.godaddy.com/v1/domains?limit=1', {
        headers: { Authorization: authorization, Accept: 'application/json' },
      });
    });
    }
    if (shouldProbe('slab')) {
    await requireSecret('slab', ['SLAB_API_TOKEN'], async (key) => {
      await httpJson('https://api.slab.com/v1/graphql', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ currentUser { id } }' }),
      });
    });
    }
    if (shouldProbe('iproyal')) {
    await requireSecret('iproyal', ['IPROYAL_PROXY'], probeIproyal);
    }
  }

  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const skip = results.filter((r) => r.status === 'skip').length;
  const summary = { pass, fail, skip, results };
  console.log(JSON.stringify(summary, null, 2));
  if (fail) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(`external-provider-roundtrips: ${err.message}`);
    process.exit(1);
  });
}
