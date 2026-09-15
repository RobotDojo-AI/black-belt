#!/usr/bin/env node
/**
 * Read any Google Doc by URL or doc ID, printing plain text to stdout.
 * Uses existing OAuth tokens — no re-authentication needed.
 *
 * Usage:
 *   node ~/robotdojo/scripts/read-doc.js <url-or-doc-id> [email]
 *
 * If email is omitted, tries each connected Google account until one succeeds.
 *
 * Examples:
 *   node ~/robotdojo/scripts/read-doc.js https://docs.google.com/document/d/1Rgn42.../edit
 *   node ~/robotdojo/scripts/read-doc.js 1Rgn42hvikbpXxkpP43oqaVPTlCPwyiNryLJrT6tgG30
 *   node ~/robotdojo/scripts/read-doc.js <url> user@example.com
 */

import { getValidAccessToken, listConnectedGoogleAccounts } from '../lib/google-oauth.js';

function extractDocId(input) {
  // Full URL: extract /d/<id>/
  const urlMatch = input.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  // Bare ID (no slashes, reasonable length)
  if (/^[a-zA-Z0-9_-]{25,}$/.test(input)) return input;
  throw new Error(`Cannot parse doc ID from: ${input}`);
}

async function fetchDoc(docId, email) {
  const token = await getValidAccessToken(email);
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${docId}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Docs API ${res.status} (${email}): ${body.slice(0, 200)}`);
  }
  return res.json();
}

function docToText(doc) {
  const lines = [];
  for (const el of doc.body?.content ?? []) {
    if (!el.paragraph) continue;
    let line = '';
    for (const run of el.paragraph.elements ?? []) {
      line += run.textRun?.content ?? '';
    }
    lines.push(line);
  }
  return lines.join('');
}

async function main() {
  const [, , input, explicitEmail] = process.argv;
  if (!input) {
    console.error('Usage: read-doc.js <url-or-doc-id> [email]');
    process.exit(1);
  }

  const docId = extractDocId(input);

  const accounts = explicitEmail ? [explicitEmail] : listConnectedGoogleAccounts();
  if (accounts.length === 0) {
    console.error('No connected Google accounts found. Check dojo OAuth setup.');
    process.exit(1);
  }

  let lastErr;
  for (const email of accounts) {
    try {
      const doc = await fetchDoc(docId, email);
      const text = docToText(doc);
      process.stdout.write(text);
      process.exit(0);
    } catch (err) {
      lastErr = err;
    }
  }

  console.error(`Failed to read doc with all accounts. Last error: ${lastErr?.message}`);
  process.exit(1);
}

main();
