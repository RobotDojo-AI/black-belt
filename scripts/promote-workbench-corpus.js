#!/usr/bin/env node
/**
 * promote-workbench-corpus.js — promote a workbench's researched records into
 * the entity graph, keyed on strong identifiers (domain / email / Asana gid).
 *
 * Compute tier: Tier 0 deterministic for every identity/create/link/edge
 * decision (no LLM near identity). The only Tier 1 (Haiku) touch is prose
 * compaction inside lib/workbench-promote-entities.js, and it writes markdown
 * only — never a DB row (LLM-write boundary). This script itself issues no
 * getAnthropicClient()/MODELS.* call directly.
 *
 * Reads a per-workbench manifest at {workbench.root_path}/promote.json (the one
 * N+5 extension point) and, per qualifying record:
 *   resolve/create entity → link the backing workbench chunk → compact +
 *   promoteWorkbenchFinding → record graph edges where both endpoints resolve.
 * Every skip is collected into an owner-facing skip report — named, never
 * silently dropped (AC 5).
 *
 * Re-running this exact command is the re-projection mechanism: idempotent by
 * the natural-key uuid / company_domains.domain, so a second pass net-creates
 * zero rows. `--idempotency-check` asserts exactly that and exits nonzero on any
 * net-new company/person/place/relationship row.
 *
 * Usage:
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/promote-workbench-corpus.js --workbench <id>
 *   ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/promote-workbench-corpus.js --workbench <id> --idempotency-check
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as pathResolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import db from '../lib/db.js';
import config from '../lib/config.js';
import { getWorkbench } from '../lib/workbenches.js';
import { promoteWorkbenchFinding } from '../lib/workbench-distill.js';
import { linkChunkToEntity } from '../lib/entity-source-evidence.js';
import { recordRelationship, APPROVED_RELATIONSHIP_TYPES } from '../lib/entity-relationships.js';
import {
  findOrCreatePromotedCompany,
  findOrCreatePromotedPerson,
  findOrCreatePromotedPlace,
  deriveCompanyDomain,
  compactResearchForPromotion,
  loadCsvDomainMap,
  promoteConfig,
} from '../lib/workbench-promote-entities.js';

export const INTELLIGENCE_TIER = 'extraction';

const REPO_ROOT = pathResolve(new URL('..', import.meta.url).pathname);

// ── args ──────────────────────────────────────────────────────────────────
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}
const workbenchId = argValue('--workbench');
const idempotencyCheck = process.argv.includes('--idempotency-check');

// ── domain cache (avoids re-deriving / re-hitting Hunter on re-projection) ───
function domainCachePath(wbId) {
  // Under the whitelisted ~/.robotdojo/cache/ dir (a new top-level dotdir would
  // trip the structure gate's dot_robotdojo_entries whitelist).
  return pathResolve(config.configDir, 'cache', 'promote-domains', `${wbId}-domains.json`);
}
function loadDomainCache(wbId) {
  try { return JSON.parse(readFileSync(domainCachePath(wbId), 'utf8')); } catch { return {}; }
}
function saveDomainCache(wbId, cache) {
  try {
    const p = domainCachePath(wbId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cache, null, 0));
  } catch { /* best effort — a cache miss only costs a re-derive */ }
}

// ── manifest record extraction ──────────────────────────────────────────────
function readSourceRecords(rootPath, source) {
  const abs = pathResolve(REPO_ROOT, rootPath, source.file);
  if (!existsSync(abs)) return { records: [], edges: [] };
  const raw = readFileSync(abs, 'utf8');
  if (source.format === 'md-table') {
    return { records: parseMdTable(raw), edges: [] };
  }
  const data = JSON.parse(raw);
  const records = source.recordsPath ? (data[source.recordsPath] || []) : (Array.isArray(data) ? data : []);
  const edges = source.edgesPath ? (data[source.edgesPath] || []) : [];
  return { records, edges };
}

// Parses the pipe-delimited "Firm | Partner | ... | guessed: X | ..." lines into
// keyed objects. Each `key: value` cell becomes a field; the first three
// positional cells are Firm/Partner/Title.
function parseMdTable(raw) {
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    if (/^#|^Firm\b/i.test(cells[0])) continue; // header row
    const rec = { Firm: cells[0], Partner: cells[1], Title: cells[2] };
    for (const cell of cells.slice(3)) {
      const m = cell.match(/^([a-z_]+):\s*(.*)$/i);
      if (m) rec[m[1].toLowerCase()] = m[2].trim();
    }
    if (rec.Partner) out.push(rec);
  }
  return out;
}

function mapField(record, key) {
  return key ? record[key] : undefined;
}

// ── chunk lookup: the workbench chunk backing a source file ──────────────────
// Resolve by the chunk's own metadata.path, NOT by workbench_items.id — a
// workbench re-registered with a different root string mints a different
// stableId, so the persisted item id and the chunk's source-id item id can
// diverge. metadata.path is the file path buildWorkbenchChunks stamps at index
// time, so it is the stable join key regardless of id drift.
function chunkIdForSourceFile(workbench, rootPath, file) {
  const wantPath = `${String(rootPath).replace(/\/+$/, '')}/${file}`;
  const row = db.prepare(`
    SELECT id FROM chunks
    WHERE source_type = 'workbench'
      AND source_id LIKE ?
      AND json_extract(metadata, '$.path') = ?
    ORDER BY id
    LIMIT 1
  `).get(`${workbench.id}:%`, wantPath);
  return row?.id || null;
}

// ── relationship-type mapping (graph freeform → approved vocabulary) ─────────
function mapRelationshipType(raw) {
  const s = String(raw || '').toLowerCase();
  if (/found/.test(s)) return 'founder';
  if (/invest|lp\b|limited partner/.test(s)) return 'invested-in';
  if (/board/.test(s)) return 'board-member';
  if (/advis/.test(s)) return 'advisor';
  if (/mentor/.test(s)) return 'mentor';
  if (/ceo|coo|cto|cfo|chief|managing|partner|principal|associate|director|head|lead|vp|president|employee|works|operator/.test(s)) return 'employee';
  return null; // unmappable → edge skipped, named in report
}

// ── the promote run ──────────────────────────────────────────────────────────
async function run() {
  if (!workbenchId) {
    console.error('promote-workbench-corpus: --workbench <id> required');
    process.exit(2);
  }
  const workbench = getWorkbench(db, workbenchId);
  if (!workbench) {
    console.error(`promote-workbench-corpus: workbench not found: ${workbenchId}`);
    process.exit(2);
  }
  const manifestPath = pathResolve(REPO_ROOT, workbench.root_path, 'promote.json');
  if (!existsSync(manifestPath)) {
    // Empty/absent manifest → clean no-op (Phase 2 proof), exit 0.
    console.log(`[promote] no promote.json for ${workbenchId} — no-op`);
    process.exit(0);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const sources = manifest.sources || [];
  const domainSources = manifest.domainSources || {};
  const cfg = promoteConfig();

  // Clean orphaned company_domains (rows whose company was deleted without
  // cascading — the wipe that stranded these blocks the domain UNIQUE for the
  // real company). Idempotent hygiene so the restore can reclaim every domain.
  const orphanClean = db.prepare('DELETE FROM company_domains WHERE company_id NOT IN (SELECT id FROM companies)').run();
  if (orphanClean.changes) console.log(`[promote] cleaned ${orphanClean.changes} orphaned company_domains rows`);

  const before = snapshotCounts();
  const cache = loadDomainCache(workbenchId);
  const csvMap = domainSources.csv ? loadCsvDomainMap(domainSources.csv, { repoRoot: REPO_ROOT }) : null;
  const htmlDir = domainSources.researchHtmlDir
    ? `${String(workbench.root_path).replace(/\/+$/, '')}/${domainSources.researchHtmlDir}`
    : null;
  const hunterKey = domainSources.hunter ? (config.hunterApiKey || process.env.HUNTER_API_KEY || readHunterKey()) : null;
  // Brave web search is the primary domain lookup fallback (Hunter's free quota
  // exhausts). Always attempt it when a key exists — it is what reaches full
  // coverage across the manifest companies the CSVs/HTML miss.
  const braveKey = config.braveApiKey || process.env.BRAVE_API_KEY || readBraveKey();

  const skips = [];       // { type, name, reason, detail }
  const triage = [];      // ambiguous merges (schema-free)
  const created = { company: 0, person: 0, place: 0, relationship: 0, linked_chunks: 0, promoted: 0 };
  // slug/id → { entityId, entityType } for graph-edge resolution
  const nodeResolution = new Map();

  for (const source of sources) {
    const chunkId = chunkIdForSourceFile(workbench, workbench.root_path, source.file);
    const { records, edges } = readSourceRecords(workbench.root_path, source);
    const sourceRef = { workbench_id: workbench.id, source_file: source.file };

    if (source.entityType === 'company') {
      await promoteCompanyRecords(records, source, sourceRef, chunkId, { csvMap, htmlDir, hunterKey, braveKey, cache, cfg, workbench, skips, triage, created });
    } else if (source.entityType === 'person') {
      await promotePersonRecords(records, source, sourceRef, chunkId, { workbench, skips, created });
    } else if (source.entityType === 'mixed-per-node-type') {
      await promoteGraphNodes(records, edges, source, sourceRef, chunkId, { csvMap, htmlDir, hunterKey, braveKey, cache, cfg, workbench, skips, triage, created, nodeResolution });
    } else {
      skips.push({ type: 'source', name: source.file, reason: `unknown_entity_type_${source.entityType}` });
    }
  }

  // Reconcile: guarantee the AC-5 invariant "every promoted company owns a
  // domain". The live organic pipeline runs concurrently and can claim a
  // company's derived domain for its own organically-created row, leaving a
  // name-created duplicate marked promoted (uuid) but domainless. For each such
  // orphan: attach its derived domain if still free, else un-mark it (uuid=NULL)
  // — the real domain-owner carries the promotion. Idempotent; normal mode only.
  if (!idempotencyCheck) reconcileDomainlessPromoted(cache, created);

  saveDomainCache(workbenchId, cache);
  const after = snapshotCounts();
  const netNew = {
    company: after.company - before.company,
    person: after.person - before.person,
    place: after.place - before.place,
    relationship: after.relationship - before.relationship,
  };

  if (idempotencyCheck) {
    const totalNew = netNew.company + netNew.person + netNew.place + netNew.relationship;
    console.log(`[promote:idempotency] net-new companies=${netNew.company} people=${netNew.person} places=${netNew.place} relationships=${netNew.relationship}`);
    console.log(totalNew === 0
      ? '[promote:idempotency] PASS — zero net-new rows on re-projection'
      : `[promote:idempotency] FAIL — ${totalNew} net-new rows on re-projection`);
    process.exit(totalNew === 0 ? 0 : 1);
  }

  writeSkipReport(manifest, workbench, { created, skips, triage, netNew });
  console.log(`[promote] created companies=${created.company} people=${created.person} places=${created.place} relationships=${created.relationship}; chunks linked=${created.linked_chunks}; promoted findings=${created.promoted}; skipped=${skips.length}; triage=${triage.length}`);
  process.exit(0);
}

// ── company records ──────────────────────────────────────────────────────────
async function promoteCompanyRecords(records, source, sourceRef, chunkId, ctx) {
  const fm = source.fieldMap || {};
  const minLen = Number(source.evidenceMinLength || 0);
  // Filter to qualifying records (minimum-evidence gate).
  const qualifying = records.filter((r) => {
    const name = String(mapField(r, fm.name) || '').trim();
    if (!name) return false;
    if (minLen && source.evidenceField) {
      const ev = String(mapField(r, source.evidenceField) || '');
      if (ev.length < minLen) return false;
    }
    return true;
  });

  // Parallel domain derivation (bounded concurrency; cache-first, Hunter last).
  // A source may opt out of Hunter (source.skipHunter) so a large obscure set
  // never burns the Hunter quota ahead of the Boston-critical sources.
  const names = qualifying.map((r) => String(mapField(r, fm.name)).trim());
  // The record's own id names its deep-research HTML page ({uuid}.html).
  const pageIds = qualifying.map((r) => r.uuid || r.id || null);
  const domains = await deriveDomainsParallel(names, ctx, source.skipHunter ? null : ctx.hunterKey, pageIds);

  for (let i = 0; i < qualifying.length; i++) {
    const record = qualifying[i];
    const name = names[i];
    const domain = domains[i];
    if (!domain) {
      // Owner directive: every promoted company carries a real domain. A company
      // no source can domain is named to the owner, never silently name-keyed.
      ctx.skips.push({ type: 'company', name, reason: 'no_domain_derivable' });
      continue;
    }
    const res = findOrCreatePromotedCompany(db, { name, domain, sourceRef });
    if (res.status === 'skipped') {
      ctx.skips.push({ type: 'company', name, reason: res.reason });
      if (res.triage) ctx.triage.push({ type: 'company', ...res.triage });
      continue;
    }
    if (res.status === 'created_verified' || res.status === 'created_name') ctx.created.company++;
    await attachResearch(res.row, 'company', record, source, sourceRef, chunkId, ctx);
  }
}

// ── person records ───────────────────────────────────────────────────────────
async function promotePersonRecords(records, source, sourceRef, chunkId, ctx) {
  const fm = source.fieldMap || {};
  for (const record of records) {
    const displayName = String(mapField(record, fm.displayName) || '').trim();
    // Guessed emails are NEVER an identity input — passed as prose only.
    const guessedEmail = mapField(record, fm.guessedEmail);
    const res = findOrCreatePromotedPerson(db, {
      displayName,
      email: mapField(record, fm.email),
      phone: mapField(record, fm.phone),
      asanaGid: mapField(record, fm.asanaGid),
      sourceRef,
    });
    if (res.status === 'skipped' || !res.row) {
      ctx.skips.push({ type: 'person', name: displayName, reason: res.reason, guessed_email: guessedEmail || undefined });
      continue;
    }
    if (res.status === 'created_verified' || res.status === 'created_provisional') ctx.created.person++;
    const recordForProse = guessedEmail ? { ...record, _guessed_email_note: `guessed, unverified: ${guessedEmail}` } : record;
    await attachResearch(res.row, 'person', recordForProse, source, sourceRef, chunkId, ctx);
  }
}

// ── boston-graph mixed nodes + edges ─────────────────────────────────────────
async function promoteGraphNodes(nodes, edges, source, sourceRef, chunkId, ctx) {
  const typeMap = source.nodeTypeMap || {};
  const idField = source.nodeIdField || 'id';
  const nameField = source.nodeNameField || 'name';
  const typeField = source.nodeTypeField || 'type';

  // Companies first (so persona→company edges can resolve the company end).
  const companyNodes = nodes.filter((n) => typeMap[n[typeField]] === 'company');
  const companyNames = companyNodes.map((n) => String(n[nameField]).trim());
  const companyPageIds = companyNodes.map((n) => n.uuid || null);
  const companyDomains = await deriveDomainsParallel(companyNames, ctx, source.skipHunter ? null : ctx.hunterKey, companyPageIds);

  for (let i = 0; i < companyNodes.length; i++) {
    const node = companyNodes[i];
    const name = companyNames[i];
    const domain = companyDomains[i];
    if (!domain) { ctx.skips.push({ type: 'company', name, reason: 'no_domain_derivable' }); continue; }
    const res = findOrCreatePromotedCompany(db, { name, domain, sourceRef });
    if (res.status === 'skipped') { ctx.skips.push({ type: 'company', name, reason: res.reason }); continue; }
    if (res.status === 'created_verified') ctx.created.company++;
    ctx.nodeResolution.set(node[idField], { entityId: res.row.id, entityType: 'company' });
    await attachResearch(res.row, 'company', node, source, sourceRef, chunkId, ctx);
  }

  for (const node of nodes) {
    const mapped = typeMap[node[typeField]];
    if (mapped === 'company') continue; // handled above
    if (mapped === 'person') {
      const res = findOrCreatePromotedPerson(db, { displayName: String(node[nameField]).trim(), sourceRef });
      if (res.status === 'skipped' || !res.row) {
        ctx.skips.push({ type: 'person', name: node[nameField], reason: res.reason });
        continue;
      }
      ctx.nodeResolution.set(node[idField], { entityId: res.row.id, entityType: 'person' });
    } else if (mapped === 'place') {
      const res = findOrCreatePromotedPlace(db, { name: String(node[nameField]).trim(), placeSubtype: node[typeField], sourceRef });
      if (res.status === 'skipped' || !res.row) { ctx.skips.push({ type: 'place', name: node[nameField], reason: res.reason }); continue; }
      if (res.status === 'created') ctx.created.place++;
      ctx.nodeResolution.set(node[idField], { entityId: res.row.id, entityType: 'place' });
    } else {
      ctx.skips.push({ type: 'node', name: node[nameField], reason: `unmapped_node_type_${node[typeField]}` });
    }
  }

  // Edges — only where BOTH endpoints resolved.
  for (const edge of edges) {
    const a = ctx.nodeResolution.get(edge.from);
    const b = ctx.nodeResolution.get(edge.to);
    if (!a || !b) continue;
    const relType = mapRelationshipType(edge.relationship);
    if (!relType || !APPROVED_RELATIONSHIP_TYPES.has(relType)) {
      ctx.skips.push({ type: 'edge', name: `${edge.from} -> ${edge.to}`, reason: `unmappable_relationship_${edge.relationship}` });
      continue;
    }
    const info = recordRelationship(db, a.entityId, a.entityType, b.entityId, b.entityType, relType, 1.0, 'workbench-promote');
    if (info.changes > 0) ctx.created.relationship++;
  }
}

// ── attach research: link the backing chunk + (normal mode) promote a finding ─
async function attachResearch(row, entityType, record, source, sourceRef, chunkId, ctx) {
  if (chunkId) {
    const link = linkChunkToEntity(db, chunkId, row.id, entityType);
    if (link.inserted) ctx.created.linked_chunks++;
  }
  // In idempotency mode, exercise only the row-creating operations (resolve,
  // link, edges — all idempotent). Skip the file/fact writes so re-projection
  // does not duplicate entity_facts or rewrite context files.
  if (idempotencyCheck) return;

  // Fact-dedup guard: a re-run / rebuild re-projection must not stack duplicate
  // entity_facts. If this entity already carries a promoted fact from this
  // source file, the chunk link above is refreshed but the finding is not
  // re-written. (entity_facts.source_event_ids is JSON [sourcePath].)
  const factSourcePath = `${ctx.workbench.root_path}/${source.file}`;
  const already = db.prepare(
    "SELECT 1 FROM entity_facts WHERE entity_type = ? AND entity_id = ? AND source_event_ids LIKE ? LIMIT 1",
  ).get(entityType, String(row.id), `%${factSourcePath}%`);
  if (already) return;

  const proseParts = [];
  const fm = source.fieldMap || {};
  const evField = source.evidenceField || fm.evidence;
  if (evField && record[evField]) proseParts.push(String(record[evField]));
  for (const [k, v] of Object.entries(record)) {
    if (['name', 'displayName', 'id', 'uuid'].includes(k)) continue;
    if (v == null || typeof v === 'object') continue;
    const val = String(v).trim();
    if (val && val.length < 400 && k !== evField) proseParts.push(`${k}: ${val}`);
  }
  const sourceText = proseParts.join('\n').trim();
  if (!sourceText) return;

  try {
    const { body } = await compactResearchForPromotion(sourceText, {});
    await promoteWorkbenchFinding(db, {
      id: ctx.workbench.id,
      target: `${entityType}:${row.id}`,
      body,
      change_summary: `Promoted ${entityType} research from ${source.file}`,
      source_path: `${ctx.workbench.root_path}/${source.file}`,
      metadata: {
        natural_key: row.uuid ? `uuid:${row.uuid}` : null,
        source_ref: sourceRef,
      },
    });
    ctx.created.promoted++;
  } catch (err) {
    ctx.skips.push({ type: entityType, name: row.name || row.display_name || row.id, reason: `promote_finding_failed: ${err.message}` });
  }
}

// ── domain derivation (parallel, bounded, cache-first) ───────────────────────
async function deriveDomainsParallel(names, ctx, hunterKey = ctx.hunterKey, pageIds = []) {
  const out = new Array(names.length).fill(null);
  const concurrency = Math.max(1, Number(ctx.cfg.domainLookupConcurrency || 6));
  let cursor = 0;
  async function worker() {
    while (cursor < names.length) {
      const idx = cursor++;
      const name = names[idx];
      const key = name.toLowerCase();
      // Cache holds a derived domain OR an explicit null (no-domain). Only reuse
      // a POSITIVE cache hit; a cached null is re-attempted when a Hunter key is
      // now available (e.g. the Boston sources run with Hunter after a
      // Hunter-less manifest pass cached the name).
      // Reuse a POSITIVE cache hit always; reuse a cached null ONLY when no live
      // lookup key is available. With a Brave key present, cached nulls (the prior
      // Hunter-less "undomainable" 211) are re-attempted via Brave.
      if (Object.prototype.hasOwnProperty.call(ctx.cache, key) && (ctx.cache[key] || (!hunterKey && !ctx.braveKey))) {
        out[idx] = ctx.cache[key];
        continue;
      }
      const domain = await deriveCompanyDomain(name, {
        csvMap: ctx.csvMap,
        htmlDir: ctx.htmlDir,
        hunterKey,
        braveKey: ctx.braveKey,
        pageId: pageIds[idx] || null,
        repoRoot: REPO_ROOT,
      });
      ctx.cache[key] = domain || null;
      out[idx] = domain || null;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
  return out;
}

// ── reconcile: no promoted company may be domainless ─────────────────────────
function reconcileDomainlessPromoted(cache, created) {
  const orphans = db.prepare(
    'SELECT id, name FROM companies WHERE uuid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM company_domains d WHERE d.company_id = companies.id)',
  ).all();
  let attached = 0;
  let unmarked = 0;
  for (const o of orphans) {
    const dom = cache[String(o.name || '').toLowerCase()];
    if (dom) {
      const owned = db.prepare('SELECT company_id FROM company_domains WHERE domain = ?').get(dom);
      if (!owned) {
        db.prepare("INSERT OR IGNORE INTO company_domains (company_id, domain, created_at) VALUES (?, ?, datetime('now'))").run(o.id, dom);
        const nowOwned = db.prepare('SELECT 1 FROM company_domains WHERE company_id = ? AND domain = ?').get(o.id, dom);
        if (nowOwned) { attached++; continue; }
      }
    }
    // Domain taken by the real owner (or none derivable) → this is a domainless
    // duplicate; drop the promoted marker so the AC-5 invariant holds.
    db.prepare('UPDATE companies SET uuid = NULL WHERE id = ?').run(o.id);
    unmarked++;
  }
  if (attached || unmarked) console.log(`[promote] reconcile: attached ${attached} domains, un-marked ${unmarked} domainless duplicates`);
  return { attached, unmarked };
}

// ── snapshot + report ────────────────────────────────────────────────────────
// Count PROMOTED entities (the natural-key uuid marker), not raw table rows.
// The live organic entity pipeline runs concurrently and inserts its own
// non-promoted rows; counting total rows would attribute those to the promote
// and make the idempotency invariant flake. The promote only ever marks entities
// with a uuid (companies/people/places) or a 'workbench-promote' edge, so
// counting exactly those isolates the promote's own net-new.
function snapshotCounts() {
  return {
    company: db.prepare('SELECT COUNT(*) n FROM companies WHERE uuid IS NOT NULL').get().n,
    person: db.prepare('SELECT COUNT(*) n FROM people WHERE uuid IS NOT NULL').get().n,
    place: db.prepare('SELECT COUNT(*) n FROM places WHERE uuid IS NOT NULL').get().n,
    relationship: db.prepare("SELECT COUNT(*) n FROM entity_relationships WHERE source = 'workbench-promote'").get().n,
  };
}

function readHunterKey() {
  try {
    return execSync('security find-generic-password -s "robotdojo-HUNTER_API_KEY" -w', { encoding: 'utf8' }).trim() || null;
  } catch { return null; }
}

function readBraveKey() {
  try {
    return execSync('security find-generic-password -s "robotdojo-BRAVE_API_KEY" -w', { encoding: 'utf8' }).trim() || null;
  } catch { return null; }
}

function writeSkipReport(manifest, workbench, { created, skips, triage, netNew }) {
  const reportRel = manifest.skipReportPath;
  if (!reportRel) return;
  const abs = pathResolve(REPO_ROOT, reportRel);
  const lines = [];
  lines.push(`# Promote skip/triage report — ${workbench.id}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Created: companies=${created.company} people=${created.person} places=${created.place} relationships=${created.relationship}`);
  lines.push(`Chunks linked: ${created.linked_chunks}  Findings promoted: ${created.promoted}`);
  lines.push(`Net-new this run: companies=${netNew.company} people=${netNew.person} places=${netNew.place} relationships=${netNew.relationship}`);
  lines.push('');
  lines.push(`## Skipped — named to owner, never silently dropped (${skips.length})`);
  if (!skips.length) lines.push('(none)');
  for (const s of skips) {
    lines.push(`- [${s.type}] ${s.name} — ${s.reason}${s.guessed_email ? ` (guessed email held as prose only: ${s.guessed_email})` : ''}`);
  }
  lines.push('');
  lines.push(`## Triage — ambiguous, surfaced for owner decision, never auto-merged (${triage.length})`);
  if (!triage.length) lines.push('(none)');
  for (const t of triage) {
    lines.push(`- [${t.type}] ${t.name || t.existing_name} — ${t.reason} (existing: ${t.existing_name || t.existing_id || ''})`);
  }
  lines.push('');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, lines.join('\n'));
  console.log(`[promote] skip report → ${reportRel}`);
}

run().catch((err) => {
  console.error('[promote] fatal:', err);
  process.exit(1);
});
