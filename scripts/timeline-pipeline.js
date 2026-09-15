#!/usr/bin/env node
/**
 * Timeline pipeline — background job runner.
 *
 * Phase 1: Key document extraction from email bodies + attachments
 * Phase 2: Receipt extraction from email bodies
 * Phase 3: Rebuild address timeline for every affected person
 * Phase 4: Report
 *
 * Idempotent via raw_text_hash. Safe to re-run; only new / changed signals
 * are re-processed.
 *
 * Runs inside the pipeline_ingest maintenance routine (continuous; see
 * docs/timeline-pipeline.md) or manually via the CLI below.
 */

import { createHash } from 'crypto';
import db from '../lib/db.js';
import { classifyDocument } from '../lib/doc-classify.js';
import { extractDocument } from '../lib/doc-extract.js';
import { classifyReceipt } from '../lib/receipt-classify.js';
import { extractReceipt } from '../lib/receipt-extract.js';
import { insertTimelineEventForDb } from '../lib/timeline-schema.js';
// st_bc949e7c Phase 3.6: post-consolidation. BB functions are statically
// imported; the runtime gate is `isBBActive()`. When inactive, this script
// no-ops on BB phases without exiting (it still does WB pipeline work).
import { isBBActive } from '../lib/cohort/active.js';
import * as bb from '../lib/bb/index.js';
const _bbActive = await isBBActive();
const rebuildAllAddressTimelines = _bbActive
  ? bb.rebuildAllAddressTimelines
  : (() => ({ people_processed: 0, rows_written: 0 }));
import { CATEGORIES as DOC_CATEGORIES } from '../lib/document-vault.js';
import { requireIdentity, ownerEmails, ownerPersonId } from '../lib/identity.js';

// Owner emails load from ~/.robotdojo/identity.json (never hardcoded).
// See lib/identity.js for the shape.
function resolveOwnerPersonId() {
  // Prefer explicit owner_person_id from identity.json.
  const explicit = ownerPersonId();
  if (explicit) return explicit;
  // Fall back to resolving via person_identifiers by known emails.
  const emails = ownerEmails();
  if (emails.length === 0) return null;
  try {
    const row = db.prepare(`
      SELECT person_id FROM person_identifiers
      WHERE type = 'email' AND LOWER(value) IN (${emails.map(() => '?').join(',')})
      LIMIT 1
    `).get(...emails);
    return row?.person_id || null;
  } catch { return null; }
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

function hashExists(table, hash) {
  const row = db.prepare(`SELECT 1 FROM ${table} WHERE raw_text_hash = ?`).get(hash);
  return !!row;
}

function recordKeyDocumentTimeline(row) {
  if (!row) return;
  try {
    insertTimelineEventForDb(db, {
      sourceType: 'key_document',
      sourceId: String(row.id),
      eventDate: row.document_date || row.received_at || row.created_at,
      eventType: row.doc_type || 'key_document',
      summary: row.doc_type || 'Key document',
      content: row.extracted_json || '',
      metadata: {
        source_id: row.source_id || null,
        source_type: row.source_type || null,
        owner_person_id: row.owner_person_id || null,
        document_date: row.document_date || null,
        received_at: row.received_at || null,
        extraction_confidence: row.extraction_confidence ?? null,
        extraction_model: row.extraction_model || null,
        raw_text_hash: row.raw_text_hash || null,
      },
    });
  } catch { /* projection only — recalc can rebuild from key_documents */ }
}

function recordReceiptTimeline(row) {
  if (!row) return;
  try {
    insertTimelineEventForDb(db, {
      sourceType: 'receipt',
      sourceId: String(row.id),
      eventDate: row.purchase_date || row.created_at,
      eventType: 'receipt',
      summary: row.merchant || row.platform || row.category || 'Receipt',
      content: row.items_json || '',
      metadata: {
        source_id: row.source_id || null,
        source_type: row.source_type || null,
        category: row.category || null,
        platform: row.platform || null,
        amount_cents: row.amount_cents ?? null,
        currency: row.currency || null,
        owner_person_id: row.owner_person_id || null,
        extraction_confidence: row.extraction_confidence ?? null,
        extraction_model: row.extraction_model || null,
        raw_text_hash: row.raw_text_hash || null,
      },
    });
  } catch { /* projection only — recalc can rebuild from receipts */ }
}

// --- Phase 1: key documents ---

// Collect high-signal sender domains from document-vault categories.
const DOC_SENDER_DOMAINS = Object.values(DOC_CATEGORIES)
  .flatMap(c => c.senders)
  .map(s => s.replace(/\./g, '.'));

function buildDocDomainClause() {
  return DOC_SENDER_DOMAINS.map(() => `LOWER(sender_email) LIKE ?`).join(' OR ');
}

async function extractDocumentsFromEmails({ limit, since, dryRun }) {
  const stats = { scanned: 0, classified: 0, extracted: 0, skipped: 0, errors: 0 };
  const owner = resolveOwnerPersonId();

  const clause = buildDocDomainClause();
  const params = DOC_SENDER_DOMAINS.map(d => `%@%${d}`);
  let sql = `SELECT id, subject, sender_email, received_at, body_text
             FROM emails
             WHERE body_text != '' AND (${clause})`;
  if (since) { sql += ' AND received_at > ?'; params.push(since); }
  sql += ' ORDER BY received_at DESC';
  if (limit) sql += ` LIMIT ${parseInt(limit, 10)}`;

  const emails = db.prepare(sql).all(...params);
  stats.scanned = emails.length;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO key_documents
      (source_id, source_type, doc_type, extracted_json, owner_person_id,
       document_date, received_at, extraction_confidence, extraction_model, raw_text_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const e of emails) {
    const text = (e.subject + '\n\n' + e.body_text).slice(0, 16000);
    const hash = sha256(text);
    if (hashExists('key_documents', hash)) { stats.skipped++; continue; }

    try {
      const cls = await classifyDocument(text, { subject: e.subject, sender: e.sender_email });
      if (!cls || cls.doc_type === 'other') { stats.skipped++; continue; }
      stats.classified++;

      if (dryRun) continue;

      const ext = await extractDocument(text, cls.doc_type, { subject: e.subject, sender: e.sender_email });
      if (!ext) { stats.errors++; continue; }

      const extJson = ext.extracted_json || {};
      const docDate = extJson.document_date || extJson.effective_date || extJson.period_start ||
                      extJson.service_period_start || extJson.lease_start || extJson.issue_date || null;

      const result = insert.run(
        e.id, 'email', cls.doc_type, JSON.stringify(extJson), owner,
        docDate, e.received_at,
        ext.extraction_confidence, ext.extraction_model, hash
      );
      if (result.changes > 0) {
        recordKeyDocumentTimeline(db.prepare('SELECT * FROM key_documents WHERE raw_text_hash = ?').get(hash));
      }
      stats.extracted++;
    } catch (err) {
      console.warn(`[timeline-pipeline] doc error (${e.id}):`, err.message);
      stats.errors++;
    }
  }
  return stats;
}

// --- Phase 2: receipts ---

async function extractReceiptsFromEmails({ limit, since, dryRun }) {
  const stats = { scanned: 0, classified: 0, extracted: 0, skipped: 0, errors: 0 };
  const owner = resolveOwnerPersonId();

  // Cheap pre-filter: only emails whose sender matches a known receipt domain.
  // (receipt-classify.js DOMAIN_RULES is authoritative; we do a loose domain check here.)
  const RECEIPT_DOMAINS = [
    'amazon.com','marketplace.amazon.com','pharmacypackage.amazon.com','amazonfresh','wholefoods',
    'instacart.com','freshdirect.com','wegmans.com','misfitsmarket.com',
    'doordash.com','ubereats.com','uber.com','grubhub.com','seamless.com','caviar.com',
    'capsulecare.com','pillpack.com',
    'pseg.com','coned.com','nationalgrid.com','duke-energy.com','pge.com','sce.com','delmarva.com','pepco.com',
    'comcast.com','xfinity.com','spectrum.com','verizon.com','att.com',
    'delta.com','united.com','aa.com','southwest.com','jetblue.com','alaska.com',
    'marriott.com','hilton.com','hyatt.com','ihg.com','choicehotels.com','booking.com','airbnb.com','vrbo.com','expedia.com',
    'lyft.com','ticketmaster.com','stubhub.com','seatgeek.com','axs.com','eventbrite.com',
    'netflix.com','spotify.com','hulu.com','apple.com','disneyplus.com',
  ];
  const clause = RECEIPT_DOMAINS.map(() => `LOWER(sender_email) LIKE ?`).join(' OR ');
  const params = RECEIPT_DOMAINS.map(d => `%@%${d}`);
  let sql = `SELECT id, subject, sender_email, received_at, body_text
             FROM emails WHERE body_text != '' AND (${clause})`;
  if (since) { sql += ' AND received_at > ?'; params.push(since); }
  sql += ' ORDER BY received_at DESC';
  if (limit) sql += ` LIMIT ${parseInt(limit, 10)}`;

  const emails = db.prepare(sql).all(...params);
  stats.scanned = emails.length;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO receipts
      (source_id, source_type, category, merchant, platform, purchase_date,
       amount_cents, currency, delivery_address_json, billing_address_json, items_json,
       is_gift, owner_person_id, extraction_confidence, extraction_model, raw_text_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const e of emails) {
    const cls = classifyReceipt({ sender_email: e.sender_email, subject: e.subject });
    if (!cls) { stats.skipped++; continue; }
    stats.classified++;

    const text = (e.subject + '\n\n' + e.body_text).slice(0, 12000);
    const hash = sha256(text);
    if (hashExists('receipts', hash)) { stats.skipped++; continue; }

    if (dryRun) continue;

    try {
      const result = await extractReceipt(text, cls);
      if (!result) { stats.errors++; continue; }
      const ext = result.extracted || {};

      const resultInfo = insert.run(
        e.id, 'email', ext.category || cls.category, ext.merchant || cls.merchant, ext.platform || cls.platform,
        ext.order_date || e.received_at,
        ext.total_amount_cents ?? null,
        ext.currency || 'USD',
        ext.delivery_address ? JSON.stringify(ext.delivery_address) : null,
        ext.billing_address ? JSON.stringify(ext.billing_address) : null,
        ext.items ? JSON.stringify(ext.items) : null,
        ext.is_gift ? 1 : 0,
        owner,
        result.extraction_confidence, result.extraction_model, hash
      );
      if (resultInfo.changes > 0) {
        recordReceiptTimeline(db.prepare('SELECT * FROM receipts WHERE raw_text_hash = ?').get(hash));
      }
      stats.extracted++;
    } catch (err) {
      console.warn(`[timeline-pipeline] receipt error (${e.id}):`, err.message);
      stats.errors++;
    }
  }
  return stats;
}

// --- Entry point ---

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const [k, v = true] = a.replace(/^--/, '').split('=');
    return [k, v];
  }));
  const dryRun = args['dry-run'] === true || args['dry-run'] === 'true';
  const limit = args.limit ? parseInt(args.limit, 10) : null;
  const since = args.since || null;

  console.info('=== Timeline pipeline ===');
  console.info(`dry_run=${dryRun} limit=${limit ?? 'all'} since=${since ?? 'all-time'}`);

  // Fail loud if identity isn't configured. Nothing downstream works without
  // owner emails — don't silently produce garbage.
  requireIdentity();

  const t0 = Date.now();

  console.info('\n[phase 1] Scanning emails for key documents...');
  const docs = await extractDocumentsFromEmails({ limit, since, dryRun });
  console.info(`[phase 1] docs:`, docs);

  console.info('\n[phase 2] Scanning emails for receipts...');
  const rcpts = await extractReceiptsFromEmails({ limit, since, dryRun });
  console.info(`[phase 2] receipts:`, rcpts);

  let timeline = { people_processed: 0, rows_written: 0 };
  if (!dryRun) {
    console.info('\n[phase 3] Rebuilding address timelines...');
    timeline = rebuildAllAddressTimelines();
    console.info(`[phase 3] timeline:`, timeline);
  }

  const summary = {
    documents_processed: docs.extracted,
    receipts_processed: rcpts.extracted,
    addresses_created: timeline.rows_written,
    people_affected: timeline.people_processed,
    elapsed_s: Number(((Date.now() - t0) / 1000).toFixed(1)),
  };
  console.info('\n[summary]', summary);
  return summary;
}

main().catch(err => {
  console.error('[timeline-pipeline] fatal:', err);
  process.exit(1);
});
