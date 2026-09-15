#!/usr/bin/env node
/**
 * create-gmail-drafts.js — create Gmail DRAFTS in a connected Google account.
 *
 * SAFETY (load-bearing): this tool creates drafts ONLY. The single Gmail
 * endpoint it ever calls is POST /gmail/v1/users/me/drafts (drafts.create).
 * There is no send code path anywhere in this file — no /messages/send, no
 * /drafts/send. It cannot send mail by construction. A draft sits in the
 * account's Drafts folder until a human opens it and sends it.
 *
 * Auth: uses lib/google-oauth.js getValidAccessToken(account) — Keychain-backed
 * OAuth for a Google account already connected to robotdojo. Requires the
 * gmail.compose (or gmail.modify) scope; the tool checks and refuses otherwise.
 *
 * Usage:
 *   node scripts/create-gmail-drafts.js --account you@gmail.com --file drafts.json
 *   node scripts/create-gmail-drafts.js --account you@gmail.com --dry-run < drafts.json
 *   cat drafts.json | node scripts/create-gmail-drafts.js --account you@gmail.com
 *
 * Payload (--file or stdin), JSON:
 *   {
 *     "account": "you@gmail.com",           // optional if --account passed
 *     "drafts": [
 *       {
 *         "to": "someone@firm.com",          // required (comma-separate for multiple)
 *         "subject": "…",                    // required
 *         "body": "plain text\n\nparagraphs",// required; sent as text/plain
 *         "cc": "…",                          // optional
 *         "attachments": ["/abs/path.pdf"]   // optional absolute paths
 *       }
 *     ]
 *   }
 *
 * Exit non-zero on any failure; prints a JSON summary of created draft ids.
 */

import fs from 'node:fs';
import pathMod from 'node:path';
import { getValidAccessToken } from '../lib/google-oauth.js';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--account') out.account = argv[++i];
    else if (a === '--file') out.file = argv[++i];
  }
  return out;
}

function readPayload(file) {
  const raw = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  const p = JSON.parse(raw);
  if (!p || !Array.isArray(p.drafts)) throw new Error('payload must be { drafts: [...] }');
  return p;
}

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
};

function b64url(buf) {
  return Buffer.from(buf, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Hard line breaks inside a paragraph freeze the wrap at whatever column the
// author's editor used. A text/plain-only message shows that verbatim, so the
// recipient sees a ragged machine-cut block instead of prose. Join wrapped lines
// back into one logical line; a break after a short line is deliberate (signature,
// list item) and is preserved.
function unwrap(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map(p => p.split('\n').reduce((acc, line) => {
      const prev = acc[acc.length - 1];
      if (prev !== undefined && prev.length > 55) { acc[acc.length - 1] = `${prev} ${line.trim()}`; return acc; }
      acc.push(line); return acc;
    }, []).join('\n'))
    .join('\n\n');
}

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Gmail's own composer emits multipart/alternative with an HTML part; a
// plain-text-only message is visibly not that, which is why one must always be
// present. Derived from `body` when the caller does not supply `html`.
function htmlFromText(text) {
  const linkify = s => s.replace(/(https?:\/\/[^\s<]+[^\s<.,)])/g, '<a href="$1">$1</a>');
  return unwrap(text)
    .split('\n')
    .map(line => (line.trim() === '' ? '<div><br></div>' : `<div>${linkify(esc(line))}</div>`))
    .join('');
}

// Every draft ships as a multipart/alternative pair: the unwrapped text as the
// fallback, HTML as what virtually every client actually renders. `html` may be
// supplied to control the rich body (real hyperlinks, emphasis); otherwise it is
// derived so no draft can go out as bare, hard-wrapped text.
function altPart(d, boundary) {
  const A = 'alt_' + boundary;
  return [
    `Content-Type: multipart/alternative; boundary="${A}"`, '',
    `--${A}`, 'Content-Type: text/plain; charset="UTF-8"', '', unwrap(d.body),
    `--${A}`, 'Content-Type: text/html; charset="UTF-8"', '', String(d.html || htmlFromText(d.body)),
    `--${A}--`, '',
  ];
}

function buildRaw(d) {
  const headers = [`To: ${d.to}`];
  if (d.cc) headers.push(`Cc: ${d.cc}`);
  headers.push(`Subject: ${d.subject}`, 'MIME-Version: 1.0');
  const body = String(d.body || '');
  const B = 'mixed_' + Math.abs([...(d.to + d.subject)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)).toString(36);

  if (!d.attachments || d.attachments.length === 0) {
    const msg = headers.concat(altPart(d, B)).join('\r\n');
    return b64url(msg.replace(/(?<!\r)\n/g, '\r\n'));
  }

  const parts = headers.concat([
    `Content-Type: multipart/mixed; boundary="${B}"`, '',
    `--${B}`,
  ]).concat(altPart(d, B));
  for (const ap of d.attachments) {
    const name = pathMod.basename(ap);
    const ct = MIME_BY_EXT[pathMod.extname(ap).toLowerCase()] || 'application/octet-stream';
    const data = fs.readFileSync(ap).toString('base64').replace(/(.{76})/g, '$1\r\n');
    parts.push(
      `--${B}`,
      `Content-Type: ${ct}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64', '', data,
    );
  }
  parts.push(`--${B}--`, '');
  return b64url(parts.join('\r\n').replace(/(?<!\r)\n/g, '\r\n'));
}

async function main() {
  const args = parseArgs(process.argv);
  const payload = readPayload(args.file);
  const account = args.account || payload.account;
  if (!account) throw new Error('no account: pass --account or payload.account');

  // Validate each draft up front (fail before touching the API).
  payload.drafts.forEach((d, i) => {
    if (!d.to || !d.subject || d.body == null) throw new Error(`draft[${i}] needs to, subject, body`);
    for (const ap of (d.attachments || [])) {
      if (!pathMod.isAbsolute(ap)) throw new Error(`draft[${i}] attachment must be absolute path: ${ap}`);
      if (!fs.existsSync(ap)) throw new Error(`draft[${i}] attachment not found: ${ap}`);
    }
  });

  if (args.dryRun) {
    console.log(JSON.stringify({
      dryRun: true, account,
      drafts: payload.drafts.map(d => ({ to: d.to, subject: d.subject, bodyChars: String(d.body).length, attachments: (d.attachments || []).map(p => pathMod.basename(p)) })),
    }, null, 2));
    return;
  }

  const token = await getValidAccessToken(account);
  if (!token) throw new Error(`no valid token for ${account} — connect the Google account first`);

  // Scope gate: drafts.create needs compose or modify.
  const ti = await fetch('https://oauth2.googleapis.com/tokeninfo?access_token=' + token).then(r => r.json());
  const scopes = (ti.scope || '').split(' ');
  if (!scopes.some(s => /gmail\.(compose|modify)/.test(s))) {
    throw new Error(`account ${account} lacks gmail.compose/modify scope — reconnect with compose access to create drafts`);
  }

  const results = [];
  for (const d of payload.drafts) {
    const raw = buildRaw(d);
    // === ONLY endpoint: drafts.create. Never send. ===
    const res = await fetch(`${GMAIL}/drafts`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw } }),
    });
    const j = await res.json();
    if (!res.ok) { results.push({ to: d.to, ok: false, error: `${res.status} ${JSON.stringify(j).slice(0, 160)}` }); continue; }
    results.push({ to: d.to, ok: true, draftId: j.id, subject: d.subject, attachments: (d.attachments || []).map(p => pathMod.basename(p)) });
  }

  const made = results.filter(r => r.ok).length;
  console.log(JSON.stringify({ account, created: made, total: results.length, sent: false, results }, null, 2));
  if (made !== results.length) process.exitCode = 1;
}

main().catch(e => { console.error('create-gmail-drafts: ' + e.message); process.exit(1); });
