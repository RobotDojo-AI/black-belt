#!/usr/bin/env node
/**
 * Backfill source links for historical email archives that are already present
 * in the emails table under their live mailbox accounts.
 *
 * Usage:
 *   node scripts/backfill-email-import-sources.js --dry-run
 *   node scripts/backfill-email-import-sources.js --apply
 *
 * This does not duplicate email rows or move them away from Gmail/Microsoft.
 * It creates Imports provider account lines and links matching messages through
 * email_import_sources so Accounts can show historical archive rows honestly.
 */

import db from '../lib/db.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APPLY = process.argv.includes('--apply');
const DRY_RUN = process.argv.includes('--dry-run') || !APPLY;
const sourceArg = process.argv.find((arg) => arg.startsWith('--sources='));
const sourcePath = sourceArg ? resolve(sourceArg.slice('--sources='.length)) : null;

function slugify(value) {
  return String(value || 'imported-email')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'imported-email';
}

function normalizeSource(slug, info) {
  const label = info?.label || info?.name || slug;
  const normalizedSlug = slugify(info?.slug || slug || label);
  const exactEmails = Array.isArray(info?.exactEmails) ? info.exactEmails
    : Array.isArray(info?.exact_emails) ? info.exact_emails
    : info?.email ? [info.email]
    : [];
  const domains = Array.isArray(info?.domains) ? info.domains : [];
  return {
    id: info?.id || `imports:email:${normalizedSlug}`,
    label,
    accountKey: info?.accountKey || info?.account_key || info?.email || normalizedSlug,
    exactEmails,
    domains,
  };
}

function sourcesFromObject(raw) {
  const archive = raw?.import_labels?.archive || raw?.email_sources || raw?.archive || raw;
  if (Array.isArray(archive)) {
    return archive.map((item) => normalizeSource(item?.slug || item?.id || item?.name, item));
  }
  if (archive && typeof archive === 'object') {
    return Object.entries(archive).map(([slug, info]) => normalizeSource(slug, info));
  }
  return [];
}

function loadSources() {
  const candidates = [
    sourcePath,
    resolve('user', 'imports', 'email-sources.json'),
    resolve('user', 'imports', 'sources.json'),
    resolve('config', 'private.json'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
      const sources = sourcesFromObject(parsed).filter((source) =>
        source.id && (source.exactEmails.length > 0 || source.domains.length > 0)
      );
      if (sources.length > 0) return { path: candidate, sources };
    } catch (err) {
      console.error(`[backfill-email-import-sources] could not read ${candidate}: ${err.message}`);
    }
  }
  return { path: null, sources: [] };
}

const { path: loadedSourcePath, sources: SOURCES } = loadSources();

const upsertAccount = db.prepare(`
  INSERT INTO accounts
    (id, provider, vendor, type, email, display_name, status, metadata, created_at, updated_at)
  VALUES (?, 'imports', 'imports', 'email', ?, ?, 'active', ?, datetime('now'), datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    email = excluded.email,
    display_name = excluded.display_name,
    metadata = excluded.metadata,
    status = 'active',
    updated_at = datetime('now')
`);

const insertSourceLink = db.prepare(`
  INSERT OR IGNORE INTO email_import_sources (email_id, account_id)
  VALUES (?, ?)
`);

const countLinks = db.prepare(`
  SELECT COUNT(DISTINCT email_id) AS count
  FROM email_import_sources
  WHERE account_id = ?
`);

function appendAddressClauses(clauses, params, column, source) {
  for (const email of source.exactEmails) {
    clauses.push(`lower(${column}) = ?`);
    params.push(email.toLowerCase());
  }

  for (const domain of source.domains) {
    const lower = domain.toLowerCase();
    clauses.push(`lower(${column}) LIKE ?`);
    params.push(`%@${lower}`);
    clauses.push(`lower(${column}) LIKE ?`);
    params.push(`%.${lower}`);
  }
}

function buildMatchQuery(source) {
  const params = [source.id];
  const senderClauses = [];
  const participantClauses = [];

  appendAddressClauses(senderClauses, params, 'e.sender_email', source);
  appendAddressClauses(participantClauses, params, 'p.participant_email', source);

  const filters = ['e.account_id = ?'];
  if (senderClauses.length > 0) filters.push(`(${senderClauses.join(' OR ')})`);
  if (participantClauses.length > 0) {
    filters.push(`EXISTS (
      SELECT 1
      FROM email_participants p
      WHERE p.email_id = e.id
        AND (${participantClauses.join(' OR ')})
    )`);
  }

  return {
    sql: `
      SELECT DISTINCT e.id
      FROM emails e
      WHERE ${filters.join('\n        OR ')}
      ORDER BY e.id
    `,
    params,
  };
}

function matchingEmailIds(source) {
  const query = buildMatchQuery(source);
  return db.prepare(query.sql).all(...query.params).map((row) => row.id);
}

function accountMetadata(source) {
  return JSON.stringify({
    source: 'historical_email_corpus',
    import_mode: 'source_link',
    managed_by: 'scripts/backfill-email-import-sources.js',
    domains: source.domains,
    exact_emails: source.exactEmails,
  });
}

function applySource(source, ids) {
  upsertAccount.run(source.id, source.accountKey, source.label, accountMetadata(source));
  let inserted = 0;
  for (const id of ids) {
    const result = insertSourceLink.run(id, source.id);
    inserted += result.changes || 0;
  }
  return inserted;
}

const results = [];
const tx = db.transaction(() => {
  for (const source of SOURCES) {
    const ids = matchingEmailIds(source);
    const before = countLinks.get(source.id)?.count || 0;
    const inserted = DRY_RUN ? 0 : applySource(source, ids);
    const after = DRY_RUN ? before : (countLinks.get(source.id)?.count || 0);
    results.push({
      id: source.id,
      label: source.label,
      matched: ids.length,
      existing_links: before,
      inserted_links: inserted,
      total_links: after,
    });
  }
});

tx();

console.log(JSON.stringify({
  mode: DRY_RUN ? 'dry-run' : 'apply',
  source_config: loadedSourcePath,
  sources: results,
  next_step: SOURCES.length === 0
    ? 'Create user/imports/email-sources.json or pass --sources=/path/to/email-sources.json with source labels, domains, and exactEmails.'
    : undefined,
}, null, 2));
