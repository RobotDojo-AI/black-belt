#!/usr/bin/env node
/**
 * One-shot OAuth callback server — listens on PORT (default 3334), handles
 * the Google callback, stores tokens in Keychain, then exits.
 *
 * Usage: node scripts/oauth-callback-server.js [port]
 */
import { createServer } from 'http';
import { URL } from 'url';
import config, { secret } from '../lib/config.js';
import { storeGoogleTokens } from '../lib/google-oauth.js';

const PORT = parseInt(process.argv[2], 10) || config.ports.site;
const CLIENT_ID     = secret('GOOGLE_CLIENT_ID');
const CLIENT_SECRET = secret('GOOGLE_CLIENT_SECRET');
const REDIRECT_URI  = `http://localhost:${PORT}/auth/google/callback`;
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';
const USERINFO_URL  = 'https://www.googleapis.com/oauth2/v3/userinfo';

const SCOPES = [
  'email',
  'profile',
  'openid',
  // Gmail — sensitive scopes only (no restricted)
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
  // Calendar — full CRUD
  'https://www.googleapis.com/auth/calendar',
  // Contacts — full CRUD
  'https://www.googleapis.com/auth/contacts',
  // Drive — access only to files created by this app
  'https://www.googleapis.com/auth/drive.file',
  // Docs, Sheets, Slides — full CRUD
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  // Photos — read-only (metadata + media, no write/delete)
  'https://www.googleapis.com/auth/photoslibrary.readonly',
  // Search Console — read + write. WHY full webmasters (not the read-only
  // variant): st_ea15ae66 auto-heal expansion needs sitemaps.submit after a
  // fix lands. sitemaps.submit requires the write scope; the read-only scope
  // returns 403. Re-auth required for the owner account after this change.
  'https://www.googleapis.com/auth/webmasters',
].join(' ');

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERR: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not in Keychain');
  process.exit(1);
}

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id:     CLIENT_ID,
  redirect_uri:  REDIRECT_URI,
  response_type: 'code',
  scope:         SCOPES,
  access_type:   'offline',
  prompt:        'consent',
}).toString();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/auth/google/callback') {
    res.writeHead(404); res.end('not found'); return;
  }

  const code  = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2>OAuth error: ${error || 'no code'}</h2>`);
    server.close();
    return;
  }

  try {
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });

    if (!tokenRes.ok) throw new Error(`token exchange: ${tokenRes.status} ${await tokenRes.text()}`);
    const tokens = await tokenRes.json();

    const infoRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const info  = infoRes.ok ? await infoRes.json() : {};
    const email = info.email;
    if (!email) throw new Error('could not determine account email');

    const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
    storeGoogleTokens(email, {
      access:  tokens.access_token,
      refresh: tokens.refresh_token || null,
      expiry,
    });

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<h2>✓ Authorized ${email}</h2><p>Tokens stored. You can close this tab.</p>`);
    console.log(`\n✓ Tokens stored for ${email} — expiry ${expiry}`);
    console.log('Run: node scripts/dmarc-parse.js --setup\n');
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h2>Error</h2><pre>${e.message}</pre>`);
    console.error('ERR:', e.message);
  } finally {
    setTimeout(() => server.close(), 500);
  }
});

server.listen(PORT, () => {
  console.log(`\nOAuth callback server on port ${PORT}`);
  console.log('\nOpen this URL in your browser:\n');
  console.log(authUrl);
  console.log('');
});
