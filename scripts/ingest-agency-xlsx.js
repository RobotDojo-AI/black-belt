/**
 * ingest-agency-xlsx.js — Collection Agency XLSX → DB entities + context files + RAG chunks
 *
 * Called as a subprocess by lib/drop-folder/route-xlsx.js:
 *   node scripts/ingest-agency-xlsx.js /path/to/file.xlsx
 *
 * WHY subprocess pattern: ingestion takes 5–30s (entity matching, embedding,
 * scoring). The drop-folder pipeline must return immediately; this script runs
 * detached so it never blocks the watcher queue.
 *
 * === Compute Tier Protocol ===
 * Tier 0 (this script):  SQL + Jaro-Winkler match ~40 rows against ~33K companies
 * No Tier 1/2 needed:    ~40 chunks, embed inline via local Snowflake.
 *
 * === Architecture principle ===
 * Schema = universal. Context file = domain-specific.
 * DB columns: name, industry, hq, year_founded, description, company_type
 * Context file: BBB rating, digital capability, compliance flag, credentials, tier, ranking notes
 */

import ExcelJS from 'exceljs';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// -- Constants (all tunables at top, not inline magic numbers) --
// TOPIC_SLUG: pass as second CLI arg or set AGENCY_TOPIC_SLUG env var
const TOPIC_SLUG      = process.argv[3] || process.env.AGENCY_TOPIC_SLUG;
const COMPANIES_DIR   = join(homedir(), 'robotdojo', 'system', 'companies');
const XLSX_PATH       = process.argv[2];

// Column indices for 'Collection Agencies' sheet (0-based after .values slice(1))
// Row 1 (header): Overall Ranking | Agency | Headquarters | Key Credentials |
//   Specialty/Notes | Digital | Compliance Flag | Tier | Primary Debt Type |
//   Year Founded | BBB Rating | ...
const COL = {
  RANKING:     0,  // col A — domain only (context file)
  AGENCY:      1,  // col B — company name
  HQ:          2,  // col C — universal field
  CREDENTIALS: 3,  // col D — domain only (context file)
  SPECIALTY:   4,  // col E — description (universal: specialty/notes)
  DIGITAL:     5,  // col F — domain only (context file)
  COMPLIANCE:  6,  // col G — domain only (context file)
  TIER_XLSX:   7,  // col H — domain only (context file; NOT stored as DB column)
  DEBT_TYPE:   8,  // col I — industry (universal field)
  YEAR_FOUNDED: 9, // col J — universal field
  BBB_RATING:  10, // col K — domain only (context file)
};

// Dynamic import to avoid blocking the module loader at spawn time
const { default: db } = await import('../lib/db.js');
const ENTITY_MATCH_THRESHOLD = 0.85;
function jaroWinkler(s1, s2) {
  if (!s1 || !s2) return 0;
  const a = s1.toLowerCase(), b = s2.toLowerCase();
  if (a === b) return 1;
  const l1 = a.length, l2 = b.length;
  const window = Math.max(0, Math.floor(Math.max(l1, l2) / 2) - 1);
  const m1 = new Array(l1).fill(false), m2 = new Array(l2).fill(false);
  let matches = 0;
  for (let i = 0; i < l1; i++) {
    const lo = Math.max(0, i - window), hi = Math.min(i + window, l2 - 1);
    for (let j = lo; j <= hi; j++) {
      if (!m2[j] && a[i] === b[j]) { m1[i] = m2[j] = true; matches++; break; }
    }
  }
  if (matches === 0) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < l1; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / l1 + matches / l2 + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, l1, l2); i++) { if (a[i] === b[i]) prefix++; else break; }
  return jaro + prefix * 0.1 * (1 - jaro);
}
const {
  safeEmbed,
  CHUNK_SIZE,
  EMBED_DIM,
  EMBED_MODEL,
  contentHash,
  embeddingSignature,
  vectorToBuffer,
} = await import('../lib/rag.js');
const { computeAllScores } = await import('../lib/scoring.js');

const MATCH_THRESHOLD = ENTITY_MATCH_THRESHOLD;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** WHY kebabCase: company IDs use slug form for human-readable, URL-safe IDs */
function kebabCase(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** WHY normalize: Jaro-Winkler matching is case/punctuation sensitive — normalize first */
function normalizeCompanyName(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Get cell value as trimmed string, null if empty */
function cellStr(row, idx) {
  const v = row.values[idx + 1]; // exceljs row.values is 1-indexed
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object' && v.text) return String(v.text).trim() || null; // RichText
  return String(v).trim() || null;
}

/** Get cell value as integer, null if empty/unparseable */
function cellInt(row, idx) {
  const s = cellStr(row, idx);
  if (!s) return null;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

// ─── Phase 1: Parse XLSX ─────────────────────────────────────────────────────

/**
 * Parse both sheets from the XLSX file.
 * Returns { agencies: [...], rankNotes: Map<normalizedName, note> }
 *
 * WHY exported: test file calls parseXlsx directly to validate ≥30 rows.
 */
export async function parseXlsx(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  // Parse 'rank' sheet first → build lookup map
  // rank sheet columns: col A = Agency Name, col C = Notes
  const rankNotes = new Map();
  const rankSheet = wb.getWorksheet('rank');
  if (rankSheet) {
    rankSheet.eachRow((row, rowNum) => {
      if (rowNum === 1) return; // skip header
      const name = cellStr(row, 0); // col A
      const notes = cellStr(row, 2); // col C
      if (name) {
        rankNotes.set(normalizeCompanyName(name), notes || 'Not ranked');
      }
    });
  }

  // Parse 'Collection Agencies' sheet
  const mainSheet = wb.getWorksheet('Collection Agencies') || wb.worksheets[0];
  const agencies = [];

  mainSheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return; // skip header row

    const name = cellStr(row, COL.AGENCY);
    if (!name) return; // skip blank rows

    agencies.push({
      name,
      hq:            cellStr(row, COL.HQ),
      key_credentials: cellStr(row, COL.CREDENTIALS),
      specialty:     cellStr(row, COL.SPECIALTY),
      digital:       cellStr(row, COL.DIGITAL),
      compliance_flag: cellStr(row, COL.COMPLIANCE),
      xlsx_tier:     cellStr(row, COL.TIER_XLSX),
      industry:      cellStr(row, COL.DEBT_TYPE),
      year_founded:  cellInt(row, COL.YEAR_FOUNDED),
      bbb_rating:    cellStr(row, COL.BBB_RATING),
      ranking_note:  cellStr(row, COL.RANKING),
    });
  });

  return { agencies, rankNotes };
}

// ─── Phase 2: Entity matching ────────────────────────────────────────────────

/** Load ALL companies for Jaro-Winkler matching (regardless of tier/score) */
const allCompanies = db.prepare(
  'SELECT id, name FROM companies ORDER BY id',
).all();

/**
 * Match an agency name against all existing companies.
 * Returns { id, name, score } of the best match above threshold, or null.
 *
 * WHY match against all: low-resolution entities from email headers are real
 * companies. They may have low signal weight but should be promoted (not duplicated)
 * when we encounter them in authoritative sources like this XLSX.
 */
function matchCompany(agencyName) {
  const normInput = normalizeCompanyName(agencyName);
  let best = null;
  for (const co of allCompanies) {
    const normExisting = normalizeCompanyName(co.name);
    const score = jaroWinkler(normInput, normExisting);
    if (score >= MATCH_THRESHOLD) {
      if (!best || score > best.score) {
        best = { id: co.id, name: co.name, score };
      }
    }
  }
  return best;
}

// ─── Phase 3: DB upsert statements ───────────────────────────────────────────

const updateCompany = db.prepare(`
  UPDATE companies SET
    name        = ?,
    industry    = COALESCE(?, industry),
    hq          = COALESCE(?, hq),
    year_founded = COALESCE(?, year_founded),
    description  = COALESCE(?, description),
    company_type = 'agency',
    updated_at   = datetime('now')
  WHERE id = ?
`);

const insertCompany = db.prepare(`
  INSERT OR IGNORE INTO companies
    (id, name, industry, hq, year_founded, description, company_type, tier, n1)
  VALUES
    (?, ?, ?, ?, ?, ?, 'agency', 'peripheral', 'Company')
`);

const upsertTopic = db.prepare(`
  INSERT OR REPLACE INTO company_topics (company_id, topic, weight, updated_at)
  VALUES (?, ?, 1.0, datetime('now'))
`);

// WHY ON CONFLICT DO UPDATE instead of INSERT OR REPLACE: REPLACE deletes+reinserts
// the row, assigning a new autoincrement id. That orphans the existing vec entry.
// DO UPDATE preserves the rowid so the vec embedding stays valid across re-ingestions.
const upsertChunk = db.prepare(`
  INSERT INTO chunks
    (topic, source_type, source_id, chunk_index, content, metadata, token_count, embedded, skip_embed)
  VALUES (?, 'company', ?, 0, ?, ?, ?, 0, 0)
  ON CONFLICT(topic, source_type, source_id, chunk_index) DO UPDATE SET
    content = excluded.content,
    metadata = excluded.metadata,
    token_count = excluded.token_count,
    embedded = CASE WHEN chunks.content IS excluded.content THEN chunks.embedded ELSE 0 END,
    content_hash = CASE WHEN chunks.content IS excluded.content THEN chunks.content_hash ELSE NULL END,
    embedding_model_id = CASE WHEN chunks.content IS excluded.content THEN chunks.embedding_model_id ELSE NULL END,
    embedding_dim = CASE WHEN chunks.content IS excluded.content THEN chunks.embedding_dim ELSE NULL END,
    embedding_signature = CASE WHEN chunks.content IS excluded.content THEN chunks.embedding_signature ELSE NULL END,
    embedded_at = CASE WHEN chunks.content IS excluded.content THEN chunks.embedded_at ELSE NULL END,
    skip_embed = 0
`);

// chunks_fts is kept in sync automatically via AFTER INSERT/DELETE/UPDATE triggers on chunks.

// Mark a SPECIFIC chunk embedded — was a wildcard UPDATE that marked
// all chunks for a company as embedded=1, even though the vec INSERT
// loop only inserts one chunk_id at a time. Companies with N chunks
// got N-1 chunks flagged with no vector. Root cause of the 706K
// embed-flag-vs-storage drift caught at st_8c7b7a6b on 2026-05-13.
const markEmbedded = db.prepare(`
  UPDATE chunks
     SET embedded = 1,
         content_hash = ?,
         embedding_model_id = ?,
         embedding_dim = ?,
         embedding_signature = ?,
         embedded_at = datetime('now')
   WHERE id = ?
`);

// ─── Phase 4: Context file writer ────────────────────────────────────────────

/**
 * Build markdown context file content for one agency.
 * WHY context file: domain-specific fields (BBB, digital, compliance, credentials,
 * ranking) go here ONLY — never as DB columns. This generalizes to future XLSXes
 * (investors, law firms) without ever changing the companies schema.
 */
function buildContextMd(agency, rankNotes) {
  const normName = normalizeCompanyName(agency.name);
  const rankNote = rankNotes.get(normName) || 'Not ranked';

  return `# ${agency.name}
**HQ:** ${agency.hq || 'N/A'} | **Founded:** ${agency.year_founded || 'N/A'} | **Primary debt:** ${agency.industry || 'N/A'}

## About
${agency.specialty || 'No specialty notes provided.'}

## Credentials
${agency.key_credentials || 'No credentials on file.'}

## Source data (vendor evaluation)
- BBB Rating: ${agency.bbb_rating || 'N/A'}
- Digital capability: ${agency.digital || 'N/A'}
- Compliance flag: ${agency.compliance_flag || 'None identified'}
- Tier classification: ${agency.xlsx_tier || 'Unclassified'}

## Ranking notes
${rankNote}
`;
}

// ─── Main pipeline ─────────────────────────────────────────────────────────

async function run() {
  if (!TOPIC_SLUG) {
    console.error('Usage: node scripts/ingest-agency-xlsx.js <xlsx-path> <topic-slug>');
    console.error('  or set AGENCY_TOPIC_SLUG env var');
    process.exit(1);
  }

  const safeTopic = TOPIC_SLUG.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  const vecTable  = `chunk_vec_${safeTopic}`;

  // Create vec table on first ingest for this topic
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${vecTable}
    USING vec0(chunk_id TEXT PRIMARY KEY, embedding float[${EMBED_DIM}])`);

  // st_f6315f0b: DELETE-then-INSERT (sqlite-vec 0.1.9 vec0 rejects REPLACE).
  const deleteVec = db.prepare(`DELETE FROM ${vecTable} WHERE chunk_id = ?`);
  const insertVec = db.prepare(
    `INSERT INTO ${vecTable} (chunk_id, embedding) VALUES (?, ?)`,
  );
  const vecExists = db.prepare(`SELECT 1 FROM ${vecTable} WHERE chunk_id = ?`);

  console.info(`[ingest-agency-xlsx] starting: ${XLSX_PATH}`);

  // 1. Parse
  let agencies, rankNotes;
  try {
    ({ agencies, rankNotes } = await parseXlsx(XLSX_PATH));
  } catch (err) {
    console.error(`[ingest-agency-xlsx] parse failed: ${err.message}`);
    process.exit(1);
  }
  console.info(`[ingest-agency-xlsx] parsed ${agencies.length} agencies`);

  // 2. Ensure companies dir exists
  await mkdir(COMPANIES_DIR, { recursive: true });

  // 3. Upsert each agency
  const processedIds = [];

  const upsertAll = db.transaction(() => {
    for (const agency of agencies) {
      // Match against all existing companies (Jaro-Winkler ≥ MATCH_THRESHOLD)
      const match = matchCompany(agency.name);
      let companyId;

      if (match) {
        companyId = match.id;
        updateCompany.run(
          agency.name,
          agency.industry,
          agency.hq,
          agency.year_founded,
          agency.specialty,
          companyId,
        );
        console.info(
          `[ingest-agency-xlsx] matched '${agency.name}' → ${companyId} (JW: ${match.score.toFixed(3)})`,
        );
      } else {
        companyId = `company-${kebabCase(agency.name)}`;
        insertCompany.run(
          companyId,
          agency.name,
          agency.industry,
          agency.hq,
          agency.year_founded,
          agency.specialty,
        );
        console.info(`[ingest-agency-xlsx] inserted '${agency.name}' → ${companyId}`);
        // Add to in-memory list for future rows (dedup within same XLSX)
        allCompanies.push({ id: companyId, name: agency.name });
      }

      // Tag with topic
      upsertTopic.run(companyId, TOPIC_SLUG);
      processedIds.push({ companyId, agency });
    }
  });

  upsertAll();
  console.info(`[ingest-agency-xlsx] upserted ${processedIds.length} companies + topics`);

  // 4. Dynamic N tier recalculation
  // WHY: company importance is signal-driven, not assigned. After upserting all
  // companies + topics, run scoring so tier is derived from interaction data.
  // For newly inserted agencies with no prior interactions, this is a no-op
  // (score=0), which is correct — they'll gain signal as emails arrive.
  try {
    computeAllScores({ dryRun: false, verbose: false });
    console.info('[ingest-agency-xlsx] N tier recalculation complete');
  } catch (err) {
    console.warn(`[ingest-agency-xlsx] scoring failed (non-fatal): ${err.message}`);
  }

  // 5. Write context files + chunks (serial — each file write is small)
  const chunksToEmbed = [];

  for (const { companyId, agency } of processedIds) {
    const slug = kebabCase(agency.name);
    const contextMd = buildContextMd(agency, rankNotes);
    const contextPath = join(COMPANIES_DIR, `${slug}.md`);

    // Write context file (domain-specific content — never in DB columns)
    await writeFile(contextPath, contextMd, 'utf8');

    // Write chunk — full context file text for RAG indexing
    const tokenCount = Math.ceil(contextMd.length / 4);
    const metadata = JSON.stringify({
      name: agency.name,
      hq: agency.hq,
      industry: agency.industry,
      year_founded: agency.year_founded,
    });
    upsertChunk.run(TOPIC_SLUG, companyId, contextMd, metadata, tokenCount);

    // Get chunk ID and signature state for embedding.
    const chunk = db.prepare(
      `SELECT id, embedded, content_hash, embedding_model_id, embedding_dim, embedding_signature
         FROM chunks
        WHERE topic = ? AND source_type = 'company' AND source_id = ? AND chunk_index = 0`,
    ).get(TOPIC_SLUG, companyId);

    if (chunk) {
      const nextContentHash = contentHash(contextMd);
      const nextSignature = embeddingSignature({
        content_hash: nextContentHash,
        topic: TOPIC_SLUG,
        modelId: EMBED_MODEL,
        dim: EMBED_DIM,
      });
      const hasVec = !!vecExists.get(String(chunk.id));
      const current =
        chunk.embedded === 1
        && chunk.content_hash === nextContentHash
        && chunk.embedding_model_id === EMBED_MODEL
        && Number(chunk.embedding_dim) === EMBED_DIM
        && chunk.embedding_signature === nextSignature
        && hasVec;

      if (!current) {
        chunksToEmbed.push({
          id: chunk.id,
          content: contextMd,
          companyId,
          contentHash: nextContentHash,
          signature: nextSignature,
        });
      }
    }
  }

  console.info(`[ingest-agency-xlsx] wrote ${processedIds.length} context files + chunks`);

  // 6. Embed company chunks inline — parallelize in batches of 10
  // WHY inline: company context must be searchable immediately after ingestion.
  // ~40 chunks, local Snowflake, embed in parallel batches of 10.
  const EMBED_BATCH = 10;
  let embedded = 0;

  for (let i = 0; i < chunksToEmbed.length; i += EMBED_BATCH) {
    const batch = chunksToEmbed.slice(i, i + EMBED_BATCH);
    const embedPromises = batch.map((c) => safeEmbed(c.content));
    const vectors = await Promise.all(embedPromises);

    const insertBatch = db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const vec = vectors[j];
        if (!vec) {
          console.warn(`[ingest-agency-xlsx] embed failed for chunk ${batch[j].id} — skipping`);
          continue;
        }
        try {
          // WHY String(id): sqlite-vec enforces TEXT primary key strictly.
          // chunks.id is INTEGER; convert to string to satisfy vec0 type constraint.
          // rag-search.js looks up chunks by chunk_id — SQLite type affinity
          // means "2095494" matches integer 2095494 in the WHERE clause.
          const idStr = String(batch[j].id);
          deleteVec.run(idStr);
          insertVec.run(idStr, vectorToBuffer(vec));
          markEmbedded.run(
            batch[j].contentHash,
            EMBED_MODEL,
            EMBED_DIM,
            batch[j].signature,
            batch[j].id,
          );
          embedded++;
        } catch (err) {
          console.warn(`[ingest-agency-xlsx] vec insert failed for ${batch[j].id}: ${err.message}`);
        }
      }
    });
    insertBatch();
  }

  console.info(`[ingest-agency-xlsx] embedded ${embedded}/${chunksToEmbed.length} chunks`);
  console.info('[ingest-agency-xlsx] done');
}

// Only run main() when invoked as a script, not when imported by tests.
// WHY: parseXlsx is exported for unit tests; run() uses process.argv which
// isn't available in test context.
if (process.argv[1] && process.argv[1].endsWith('ingest-agency-xlsx.js')) {
  if (!XLSX_PATH) {
    console.error('[ingest-agency-xlsx] Usage: node scripts/ingest-agency-xlsx.js <path>');
    process.exit(1);
  }
  run().catch((err) => {
    console.error('[ingest-agency-xlsx] fatal:', err);
    process.exit(1);
  });
}
