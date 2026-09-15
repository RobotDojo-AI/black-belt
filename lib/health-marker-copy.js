/**
 * Health marker copy — the generated Definition / Trend / Action rows under each
 * health chart, plus one narrative per charting body area (st_3ca30b26).
 *
 * Compute tier ladder (agents/build-conventions.md):
 *   Tier 0 — free, local, no LLM. Read health_markers + health_data_points + the
 *     health topic context, assemble one deterministic input payload per subject,
 *     hash it, and diff the hash against the stored one. The omission rule runs
 *     here and costs zero tokens.
 *   Tier 2 — Sonnet, and only for the subjects whose hash moved. Batched 8 at a
 *     time, sequential.
 *   Tier 1 and Tier 3 are deliberately unused: there is no bulk classification
 *     step to hand Haiku, and Opus never runs in this pipeline (owner cost
 *     constraint: "only use sonnet for these runs to keep costs down").
 *
 * WHY the cache is the correctness mechanism, not a cost optimisation.
 * Identical requests to a hosted model do not return identical text — batch
 * invariance is a server-side property we cannot reach through the API. So
 * "reloading without a data change returns identical copy" can only be
 * guaranteed by not calling the model at all when nothing moved. The input
 * signature is a sha256 over the exact payload a subject's prompt carries;
 * unchanged inputs mean no call, which means the stored words are returned
 * byte-for-byte. Selective regeneration falls out for free: the change set IS
 * the set of subjects whose signature moved.
 *
 * WHY prose lands here and never in health_markers.description/.recommendations:
 * computeTrend (apps/health/chart.js) adds +10 to the trend score of any marker
 * carrying `recommendations`, and markerHighlightCandidate adds +6. Writing
 * generated prose to those columns would silently reorder every chart — the
 * exact defect the ordering half of this story exists to fix — and would fire
 * the migration-120 AFTER UPDATE trigger that marks the Opus intel tabs stale.
 *
 * Hard boundary held here: no generated output ever becomes a marker value,
 * reference range, target, or trend score. Prose to a prose column; every number
 * on every chart stays deterministic.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { llmCreate } from './llm-gateway.js';
import { listHealthMarkers, listDataPointsGroupedByMarker, listHealthMarkerCopyRows } from './health-queries.js';
import { enrichHealthMarker } from './health-marker-metadata.js';
import { listEffectiveMedicationsRaw } from './health-medications.js';
import { modelFor } from './model-lane.js';

export const INTELLIGENCE_TIER = 'synthesis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEALTH_UI_CONFIG_PATH = resolve(__dirname, '..', 'config', 'health-ui.json');

/**
 * Pinned with no environment override on purpose. An env-swapped model would
 * change every generated string while the signature stayed put, so the cache
 * would keep serving prose written by a model that is no longer configured and
 * nothing would ever regenerate. The model id is part of the signature instead.
 */
export const MARKER_COPY_MODEL = modelFor('balanced');

/** Batches are sequential, not parallel. Two reasons, both measured:
 *  provider rate limits (the reason runIntelRegenerationJob is already
 *  sequential), and prompt-cache semantics — a cache entry only becomes readable
 *  after the first response starts streaming, so a parallel fan-out pays the
 *  full uncached price on every call and reads the cache on none. */
const MARKER_COPY_BATCH_SIZE = 8;

/** Personalised-reference-interval floor. Below three readings there is no
 *  trend to interpret and no personal interval to interpret it against, so the
 *  block is omitted rather than filled with a template. Mirrors computeTrend's
 *  own >=3 floor in apps/health/chart.js. */
const MIN_READINGS_FOR_COPY = 3;

/** .area-narrative renders esc(narrative) into a single div, so the budget is
 *  enforced in code and not left to the model. */
const AREA_NARRATIVE_MAX_CHARS = 600;

/** Long enough for an 8-subject batch of three-row answers; the gateway default
 *  of 120s is tight for that. */
const MARKER_COPY_TIMEOUT_MS = 180_000;

const MARKER_MAX_OUTPUT_TOKENS = 4000;
const AREA_MAX_OUTPUT_TOKENS = 3000;

// ─── Registries (inverted dependencies) ───────────────────────────────────
//
// This module must not import routes/health.js. Two things it needs live there,
// so the route hands them in at boot, mirroring registerHealthMarkerPayloadWarmer.

let chartSubjectProvider = null;
let payloadRefresher = null;

/**
 * Register the source of truth for "which markers are charted, and what the
 * chart shows for each". Both are decided by the route's curation pipeline —
 * alias merge, mixed-unit split, unit normalisation, same-day collapse,
 * lab-backed source policy, dense-series reduction, derived targets,
 * auto-archive, archive preferences — 400 lines of route-local logic this
 * module has no business duplicating.
 *
 * It matters concretely, not theoretically: weight carries 284 apple-health
 * readings in pounds and 29 lab readings in kilograms in the same table. Read
 * raw, its latest value is 85.7 lb and its recent trend is -31%. Read through
 * the chart pipeline it is 28 readings against a derived 161 lb target. The
 * model must see the second.
 *
 * @param {() => object[]} provider returns the active-view chart markers.
 */
export function registerHealthChartSubjectProvider(provider) {
  chartSubjectProvider = typeof provider === 'function' ? provider : null;
}

/**
 * Register the callback that clears and re-warms the server-side marker payload
 * cache after a generation run, so the next chart fetch carries the new copy.
 * @param {(opts: { reason?: string }) => void} refresher
 */
export function registerHealthMarkerCopyPayloadRefresher(refresher) {
  payloadRefresher = typeof refresher === 'function' ? refresher : null;
}

// ─── Config + statements ──────────────────────────────────────────────────

let _uiConfig = null;
let _uiConfigMtimeMs = null;

/**
 * Read config/health-ui.json with an mtime cache.
 *
 * WHY this does not call getUIConfig() from lib/health-intel.js: health-intel
 * imports THIS module (the recalc job runs the copy step), so importing it back
 * would make the two modules a cycle. Twelve lines of file read is cheaper than
 * a cycle, and lib/health-medications.js already reads the same file the same
 * way for the same reason.
 */
function healthUIConfig() {
  try {
    const mtimeMs = statSync(HEALTH_UI_CONFIG_PATH).mtimeMs;
    if (_uiConfig && _uiConfigMtimeMs === mtimeMs) return _uiConfig;
    _uiConfig = JSON.parse(readFileSync(HEALTH_UI_CONFIG_PATH, 'utf8'));
    _uiConfigMtimeMs = mtimeMs;
  } catch {
    _uiConfig = { conditionGroups: [], rxGroups: [], bodyAreaMap: {}, rxMarkerMap: {} };
    _uiConfigMtimeMs = null;
  }
  return _uiConfig;
}

const _stmtsByDb = new WeakMap();

/** Lazy prepared statements, per database handle. Mirrors lib/health-intel.js:
 *  preparing at module scope breaks any importer whose schema is not migrated
 *  yet, and tests hand in their own in-memory handle. */
function stmts(db) {
  const cached = _stmtsByDb.get(db);
  if (cached) return cached;
  const prepared = {
    upsertCopy: db.prepare(`
      INSERT INTO health_marker_copy
        (scope, subject_id, definition, trend, action, narrative,
         omitted, omitted_reason, input_signature, model, generated_at)
      VALUES
        (@scope, @subject_id, @definition, @trend, @action, @narrative,
         @omitted, @omitted_reason, @input_signature, @model, datetime('now'))
      ON CONFLICT(scope, subject_id) DO UPDATE SET
        definition      = excluded.definition,
        trend           = excluded.trend,
        action          = excluded.action,
        narrative       = excluded.narrative,
        omitted         = excluded.omitted,
        omitted_reason  = excluded.omitted_reason,
        input_signature = excluded.input_signature,
        model           = excluded.model,
        generated_at    = datetime('now')
    `),
    healthTopicContext: db.prepare(`
      SELECT context_md FROM user_topics
      WHERE slug = 'health' AND context_md IS NOT NULL AND length(context_md) > 0
    `),
  };
  _stmtsByDb.set(db, prepared);
  return prepared;
}

// ─── Tier 0 assembly ──────────────────────────────────────────────────────

function cleanText(value) {
  return value == null ? '' : String(value).trim();
}

function round(value, places = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Extract the owner's genetic record from the health topic context.
 * Free text by design: the genotypes live in a local, gitignored DB row that
 * already holds his genetic notes, and nothing in git ever carries them.
 */
/**
 * Pull one `### `-level section out of the health topic context by heading
 * prefix, stopping at the next `### `.
 */
export function extractContextSection(contextMd, headingPrefix) {
  const md = String(contextMd || '');
  const start = md.indexOf(headingPrefix);
  if (start < 0) return '';
  const next = md.indexOf('\n### ', start + 5);
  return (next < 0 ? md.slice(start) : md.slice(start, next)).trim();
}

/**
 * Extract the owner's genetic record from the health topic context.
 * Free text by design: the genotypes live in a local, gitignored DB row that
 * already holds his genetic notes, and nothing in git ever carries them.
 */
export function extractGeneticFlags(contextMd) {
  return extractContextSection(contextMd, '### Genetic Flags');
}

/**
 * The corrections block, which is the highest-authority thing in the record and
 * was invisible to generation until now.
 *
 * It sits under its own `### Corrections` heading, ABOVE the genetics, and the
 * history block only ever read the genetics — so when the owner corrected two
 * standing facts on 2026-07-26 (chlorthalidone was never actually held; partner
 * carrier testing came back negative), neither reached the model and the copy
 * kept reasoning from the superseded version. Anything here overrides the rest
 * of the record by construction: it is what he fixed most recently.
 */
export function extractRecordCorrections(contextMd) {
  return extractContextSection(contextMd, '### Corrections');
}

/**
 * One record per canonical marker, assembled from health_markers +
 * health_data_points and enriched with the shared marker metadata.
 *
 * Alias rows (bilirubin_total, creatinine_serum_or_plasma, ...) collapse into
 * their canonical id and their points merge, because that is what the chart
 * shows. The row with the most points supplies the display fields.
 *
 * Every field here is computed by code. The model never produces a number.
 */
export function buildMarkerRecords(db) {
  const pointsByRawId = listDataPointsGroupedByMarker(db);
  const buckets = new Map();
  for (const row of listHealthMarkers(db)) {
    const enriched = enrichHealthMarker(row);
    const id = enriched.canonicalId || enriched.id;
    const bucket = buckets.get(id) || { rows: [] };
    bucket.rows.push(enriched);
    buckets.set(id, bucket);
  }

  const records = new Map();
  for (const [id, bucket] of buckets) {
    const withCounts = bucket.rows
      .map(row => ({ row, points: pointsByRawId.get(row.id) || [] }))
      .sort((a, b) => b.points.length - a.points.length || String(a.row.id).localeCompare(String(b.row.id)));
    const display = withCounts[0].row;

    // Merge across aliases, then collapse exact same-day duplicate values —
    // the same collapse the chart applies, so the count the model sees is the
    // count the owner sees rather than the raw import tally.
    const seen = new Set();
    const merged = [];
    for (const { points } of withCounts) {
      for (const point of points) {
        const value = Number(point.value);
        const date = cleanText(point.date).slice(0, 10);
        if (!date || !Number.isFinite(value)) continue;
        const key = `${date}|${value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push({ date, value });
      }
    }
    merged.sort((a, b) => a.date.localeCompare(b.date) || a.value - b.value);
    records.set(id, buildMarkerRecord(id, display, merged));
  }
  return records;
}

export function buildMarkerRecord(id, display, points) {
  const refLow = display.ref_low == null ? null : Number(display.ref_low);
  const refHigh = display.ref_high == null ? null : Number(display.ref_high);
  const target = display.target == null ? null : Number(display.target);
  const latest = points.length ? points[points.length - 1] : null;
  const prior = points.length > 1 ? points[points.length - 2] : null;

  // Same shape as computeTrend: last three readings against everything before
  // them. Rounded to one decimal so float noise cannot move a signature.
  let pctChange = null;
  if (points.length >= 4) {
    const recent = points.slice(-3);
    const earlier = points.slice(0, -3);
    const avg = list => list.reduce((sum, p) => sum + p.value, 0) / list.length;
    const earlierAvg = avg(earlier);
    if (earlierAvg !== 0) pctChange = round(((avg(recent) - earlierAvg) / earlierAvg) * 100, 1);
  }

  const record = {
    subject_id: id,
    name: cleanText(display.name) || id,
    unit: cleanText(display.unit),
    point_count: points.length,
  };
  if (refLow != null && Number.isFinite(refLow)) record.reference_low = refLow;
  if (refHigh != null && Number.isFinite(refHigh)) record.reference_high = refHigh;
  if (target != null && Number.isFinite(target)) record.target = target;
  if (display.direction) record.better_direction = display.direction;
  if (points.length) {
    record.first_reading_date = points[0].date;
    record.last_reading_date = points[points.length - 1].date;
  }
  // Rounded because unit conversion upstream leaves values like
  // 188.93615868826 lb, and a 14-digit body weight in the prompt is noise the
  // model has to read past.
  if (latest) {
    record.latest_value = round(latest.value, 3);
    record.latest_date = latest.date;
  }
  if (prior) {
    record.prior_value = round(prior.value, 3);
    record.prior_date = prior.date;
  }
  // Named for exactly what it measures. It was `recent_change_pct`, and it is
  // not a recent change: on 21 of the 55 charted markers its sign opposes the
  // last two readings, because a long series drags the earlier mean. The model
  // read the old name literally and on hemoglobin wrote "the 4.9% figure is
  // baseline-comparison artefact" into the owner's copy -- apologising in
  // production for a mislabelled input. The system prompt carries a field note
  // saying what window this compares.
  if (pctChange != null) record.drift_pct_last3_vs_earlier_mean = pctChange;
  record.reference_status = referenceStatus(latest?.value, refLow, refHigh);
  const targetStatus = targetState(latest?.value, target, display.direction);
  if (targetStatus) record.target_status = targetStatus;
  return record;
}

function referenceStatus(value, refLow, refHigh) {
  const hasLow = refLow != null && Number.isFinite(refLow);
  const hasHigh = refHigh != null && Number.isFinite(refHigh);
  if (!hasLow && !hasHigh) return 'no_reference_range_on_file';
  if (!Number.isFinite(value)) return 'no_reading';
  if (hasHigh && value > refHigh) return 'above_reference_ceiling';
  if (hasLow && value < refLow) return 'below_reference_floor';
  return 'inside_reference_range';
}

function targetState(value, target, direction) {
  if (target == null || !Number.isFinite(target) || !Number.isFinite(value)) return '';
  if (direction === 'lower') return value <= target ? 'at_target_or_better' : 'above_target';
  if (direction === 'higher') return value >= target ? 'at_target_or_better' : 'below_target';
  return value === target ? 'at_target' : (value > target ? 'above_target' : 'below_target');
}

function markerMatchesConfigList(recordId, list) {
  return Array.isArray(list) && list.includes(recordId);
}

/**
 * The protocol block for one marker, built from the rxGroups entries that name
 * it. A field absent from the record is absent from the payload — never null,
 * never "unknown". Of the six protocols only one records all four of status,
 * dose, frequency and start date, so a copy line supplying a missing dose is a
 * fabrication rather than a completion (AC 7).
 *
 * Deliberately reads the RAW rxGroups rather than medicationRowsFromHealthOntology,
 * which back-fills dose and frequency by regex over the description text. That
 * inference is fine for a medications list; here it would put a number the owner
 * never recorded in front of a model asked to reason about his protocol.
 */
function linkedProtocols(recordId, uiConfig) {
  const groups = Array.isArray(uiConfig.rxGroups) ? uiConfig.rxGroups : [];
  return groups
    .filter(group => markerMatchesConfigList(recordId, group.markers))
    .map(group => {
      const protocol = { name: cleanText(group.name) };
      for (const field of ['status', 'dose', 'frequency', 'date_started', 'date_stopped']) {
        const value = cleanText(group[field]);
        if (value) protocol[field] = value;
      }
      // `notes`, not `purpose`. This is the owner's own free prose from config,
      // and it carries half-remembered dosing history ("2mg May-Sept 2025, 4mg
      // since Dec 2025"). Handed over as `purpose`, the model read it as
      // authoritative and wrote a wrong dated claim onto lymph_abs. The name and
      // the system prompt's field note now both say the dated fields above are
      // the record and this is not.
      const notes = cleanText(group.desc);
      if (notes) protocol.notes = notes;
      return protocol;
    });
}

function linkedConditions(recordId, uiConfig) {
  const groups = Array.isArray(uiConfig.conditionGroups) ? uiConfig.conditionGroups : [];
  return groups
    .filter(group => markerMatchesConfigList(recordId, group.markers))
    .map(group => ({ name: cleanText(group.name), focus: cleanText(group.desc) }));
}

/**
 * Where a marker lives, and where it is merely read.
 *
 * The owner's rule: a marker belongs to the system whose function it MEASURES,
 * not every system it affects. LDL measures lipid transport, so its home is
 * Heart; that APOE e4 makes it matter for dementia risk is a consequence, and
 * Brain is a lens that reads it a second time. Handing the model one flat list
 * blurs exactly that distinction, so the payload keeps them apart.
 */
function linkedBodyAreas(recordId, uiConfig) {
  const areas = uiConfig.bodyAreaMap && typeof uiConfig.bodyAreaMap === 'object' ? uiConfig.bodyAreaMap : {};
  const matching = Object.entries(areas).filter(([, cfg]) => markerMatchesConfigList(recordId, cfg.markers));
  const home = matching.filter(([, cfg]) => !cfg.lens).map(([, cfg]) => cleanText(cfg.name));
  const lenses = matching.filter(([, cfg]) => cfg.lens).map(([, cfg]) => cleanText(cfg.name));
  return { home: home[0] || '', lenses };
}

/**
 * Curated medication rows linked to a marker through rxMarkerMap's name
 * patterns. Ontology-derived fallback rows are dropped: they are the rxGroups
 * entries again, with dose and frequency inferred from prose, and the protocol
 * block above already carries the recorded version of those.
 */
function linkedMedications(recordId, uiConfig, medications) {
  const patterns = uiConfig.rxMarkerMap && typeof uiConfig.rxMarkerMap === 'object' ? uiConfig.rxMarkerMap : {};
  const linked = [];
  for (const medication of medications) {
    if (medication.source === 'health_rx_ontology') continue;
    const name = cleanText(medication.name);
    if (!name) continue;
    const matches = Object.values(patterns).some(entry => {
      if (!entry?.pattern || !markerMatchesConfigList(recordId, entry.markerIds)) return false;
      try { return new RegExp(entry.pattern, 'i').test(name); } catch { return false; }
    });
    if (!matches) continue;
    const row = { name };
    for (const field of ['type', 'status', 'dose', 'frequency', 'timing', 'date_started', 'date_stopped']) {
      const value = cleanText(medication[field]);
      if (value) row[field] = value;
    }
    linked.push(row);
  }
  return linked;
}

/**
 * Turn one chart marker from the route's payload into the same record shape
 * buildMarkerRecords produces from the database, so the two sources are
 * interchangeable downstream.
 */
function recordFromChartMarker(marker) {
  const id = marker.canonicalId || marker.id;
  const points = (Array.isArray(marker.data) ? marker.data : [])
    .map(point => ({ date: cleanText(point.date).slice(0, 10), value: Number(point.value) }))
    .filter(point => point.date && Number.isFinite(point.value))
    .sort((a, b) => a.date.localeCompare(b.date) || a.value - b.value);
  return buildMarkerRecord(id, {
    name: marker.name,
    unit: marker.unit,
    ref_low: marker.refRange?.low,
    ref_high: marker.refRange?.high,
    target: marker.target,
    direction: marker.direction,
  }, points);
}

/**
 * Build one subject's object from a given record map.
 * @param {{ scope: 'marker'|'area', id: string }} subject
 * @param {object} ctx run context from buildRunContext
 * @param {Map<string, object>} recordMap which record source to read
 */
function buildSubjectObject(subject, ctx, recordMap) {
  if (subject.scope === 'area') {
    const cfg = ctx.uiConfig.bodyAreaMap?.[subject.id];
    if (!cfg) return null;
    const members = (cfg.markers || [])
      .filter(id => ctx.markerIds.includes(id))
      .map(id => recordMap.get(id))
      .filter(Boolean);
    if (!members.length) return null;
    return {
      scope: 'area',
      subject_id: subject.id,
      name: cleanText(cfg.name) || subject.id,
      // Free prose from config, same status as a protocol's `notes`: it can
      // summarise loosely (bone's context calls four genes "genetic hits" when
      // one of them is recorded as no-variant). The record block is authoritative.
      area_notes: cleanText(cfg.context),
      markers: members,
    };
  }

  const record = recordMap.get(subject.id);
  if (!record) return null;
  return buildMarkerSubjectPayload(record, ctx.uiConfig, ctx.medications);
}

/**
 * One marker's object: its own record plus the conditions, protocols,
 * medications and body areas config links to it. A field that is not on record
 * produces no key at all — never null, never "unknown" — and the system prompt
 * states that what is present is the complete record (AC 7).
 */
export function buildMarkerSubjectPayload(record, uiConfig, medications = []) {
  const payload = { scope: 'marker', ...record };
  const conditions = linkedConditions(record.subject_id, uiConfig);
  const protocols = linkedProtocols(record.subject_id, uiConfig).map(protocol => {
    // Computed here rather than left to the model to work out from two dates.
    // It shipped "the drop from 618 in September 2023 to 510 in October 2025
    // occurred during a period that includes the December 2025 finasteride
    // start" — a drug starting two months AFTER the last reading cannot be in
    // the window. Stating the relationship as a fact removes the arithmetic.
    if (!protocol.date_started || !record.last_reading_date) return protocol;
    if (protocol.date_started > record.last_reading_date) {
      return { ...protocol, started_after_last_reading: true };
    }
    return protocol;
  });
  const linkedMeds = linkedMedications(record.subject_id, uiConfig, medications);
  const areas = linkedBodyAreas(record.subject_id, uiConfig);
  if (conditions.length) payload.linked_conditions = conditions;
  if (protocols.length) payload.linked_protocols = protocols;
  if (linkedMeds.length) payload.linked_medications = linkedMeds;
  if (areas.home) payload.body_system = areas.home;
  if (areas.lenses.length) payload.also_read_under = areas.lenses;
  return payload;
}

/**
 * The exact object one subject's prompt carries.
 * @param {import('better-sqlite3').Database} db
 * @param {{ scope: 'marker'|'area', id: string }} subject
 * @param {object} [context] assembled once per run by buildCopySnapshot
 */
export function buildCopyInput(db, subject, context = null) {
  const ctx = context || buildRunContext(db);
  return buildSubjectObject(subject, ctx, ctx.records);
}

/**
 * The object a subject's signature is taken over: the same shape as the prompt
 * payload, but always assembled from the database and config rather than from
 * the route's chart pipeline.
 *
 * WHY the fingerprint and the prompt do not share a source. The prompt must
 * carry the chart-processed record or it reasons from mixed units (see
 * registerHealthChartSubjectProvider). The fingerprint must be reproducible
 * from the database alone, or "an unchanged corpus regenerates nothing" is only
 * checkable inside a running server and stops being a falsifiable property.
 *
 * What the fingerprint therefore covers: every data point, reference range,
 * target and unit on record; the linked protocols, medications, conditions and
 * body areas; the owner's conditions and genetic record; the prompt rules; and
 * the model id. Change any of those and the affected subjects — and only those
 * subjects — regenerate.
 *
 * The one input it does NOT cover is a change to the route's chart-curation
 * logic itself (a new unit rule, a changed derived target) with no underlying
 * data change. That path regenerates through `force: true`, and it is the only
 * gap between "what the model saw" and "what is hashed".
 */
function buildSubjectFingerprint(subject, ctx) {
  return buildSubjectObject(subject, ctx, ctx.dbRecords);
}

// ─── The omission rule ────────────────────────────────────────────────────

/**
 * The single omission threshold (AC 8), deterministic and evaluated before any
 * model call. Omitted rows cost zero tokens.
 *
 * Two clauses from the sealed scope collapse into one test: "fewer than three
 * readings" and "its only basis is a genetic record carrying neither a genotype
 * nor a reference range". A marker whose only basis is a genetic mention has no
 * measurements of its own, so its point count is zero and it is already below
 * the floor. One rule, both cases.
 *
 * A missing reference range is explicitly NOT a trigger. weight has 28 readings
 * and a derived target and no population range, and it keeps its copy.
 *
 * @returns {{ omitted: 0|1, omitted_reason: string }}
 */
export function markerCopyOmission(record) {
  const count = Number(record?.point_count || 0);
  if (count < MIN_READINGS_FOR_COPY) {
    return { omitted: 1, omitted_reason: count === 0 ? 'no_measurement_of_its_own' : 'insufficient_readings' };
  }
  return { omitted: 0, omitted_reason: '' };
}

// ─── Prompt ───────────────────────────────────────────────────────────────

const MARKER_RULES = `You are writing the three explanatory rows that sit under one health chart in a single owner's private health dashboard: Definition, Trend, and Action. He is the only reader. He runs his own health protocol, is technically literate, and has explicitly asked for direct recommendations.

Output shape: a JSON object {"results":[ ... ]} with one entry per requested subject_id. Each entry is either {"subject_id","definition","trend","action"} or {"subject_id","ungroundable":true}. Definition and Trend: at most two sentences and 320 characters each. Action: at most two sentences and 240 characters. Longer text is cut off in the interface. No prose outside the JSON, no markdown fences.

How to read two fields in the subject payload:

- "drift_pct_last3_vs_earlier_mean" compares the mean of his last three readings to the mean of every earlier reading. It is a lifetime-baseline comparison, not a recent move, and on a long series its sign routinely opposes the last two readings. For what changed most recently use "latest_value" and "prior_value" with their dates. Never describe this field as a recent change, and never write about the field itself.
- "started_after_last_reading": true on a protocol means that drug began AFTER this marker's most recent reading. It cannot explain anything visible in this series — do not name it as a driver, a confound or a contributor to a change that already happened.
- "notes" on a protocol, and "area_notes" on a body area, are free prose the owner wrote. They are context, not record. Dose, frequency, status and dates are authoritative ONLY from the explicit fields beside them; never derive a dose, a date, or a date range from notes prose.

Rules — these five, and only these five:

1. Key every result by its subject_id. Treat each subject independently; never carry one marker's reasoning onto another.
2. Do not restate numbers, and do not write physiology lessons. The chart already plots every value and the row above yours already states the latest value, its date, the reference range and the in-or-out-of-range status. **The Definition MUST name at least one thing from his own record — a condition he carries, a drug or protocol he takes, a gene on file, or his target for this marker.** A Definition that would read identically for any other person is a failure, however accurate: "TSH is the pituitary signal driving thyroid output" is a textbook sentence, not his.
3. Ground every claim in the record you were given. NO gene symbol, variant name or rsID may appear in your output unless that gene appears in the record — UGT1A1, JAK1 and JAK2 are forbidden however standard the textbook mechanism, because none is on file for him. A drug class named in the record does NOT license its gene: "baricitinib is a JAK inhibitor" is on file, "JAK2 signalling" is not. Name the drug and the effect, never the paralog. A genotype recorded as "no variant" is a negative result: never call it a hit, a variant or a risk allele. **Never total his genetic findings** — no "four genetic bone metabolism hits", no count of variants of any kind; name the specific genotypes that bear on the marker instead. **Never reverse or extend a recorded consequence**: the record says Factor XI deficiency carries bleeding risk after surgery or trauma, so it may not be written as a thrombosis interaction. Where he has recorded a hypothesis — as with VDR and VDBP — present it as his hypothesis with its pending panel. Where a marker has no reference range on file, make no normal-or-abnormal judgment, and never state a mechanism as established where no genotype or measurement backs it.
4. The Action gives a real recommendation with its reasoning, and it must be executable from this record: a lab or panel to draw, a protocol or dose decision, or a specific clinician conversation. Do not send him to a device, tracker or data source that does not appear in the record you were given. "Discuss with your physician", "consult a healthcare provider", "speak with your doctor", "this is not medical advice" and equivalents are prohibited as the substance of the Action. Naming a specific clinician conversation IS correct where that is the action — "raise the rosuvastatin hold with the cardiologist before the TTC window".
5. If you cannot ground a row in the record supplied, return that whole subject as {"subject_id":"...","ungroundable":true}. An invented sentence is worse than an omitted block, and a blank field is worse than either.`;

const AREA_RULES = `You are writing the summary paragraph that opens one body area of a single owner's private health dashboard, above that area's charts. He is the only reader and has explicitly asked for direct recommendations.

Output shape: a JSON object {"results":[ ... ]} with one entry per requested subject_id, each {"subject_id","narrative"} or {"subject_id","ungroundable":true}. Keep each narrative to at most 520 characters; longer text is cut off in the interface. Finish on a complete sentence — never stop mid-clause to stay inside the budget. No prose outside the JSON, no markdown fences.

How to read two fields in the subject payload:

- "drift_pct_last3_vs_earlier_mean" compares the mean of a marker's last three readings to the mean of every earlier reading. It is a lifetime-baseline comparison, not a recent move, and its sign routinely opposes the last two readings. For what changed most recently use "latest_value" and "prior_value" with their dates.
- "area_notes", and "notes" on a protocol, are free prose the owner wrote. They are context, not record, and they summarise loosely. The Owner health record block below is authoritative; never derive a dose, a date, a date range, or a genetic finding from notes prose.

Rules — these five, and only these five:

1. Key every result by its subject_id. Treat each area independently.
2. Cover the long-range trend and the current status of the area as a whole. Do not restate individual values; the charts below carry them.
3. Ground every claim in the record you were given. NO gene symbol, variant name or rsID may appear in your output unless that gene appears in the record — UGT1A1, JAK1 and JAK2 are forbidden however standard the textbook mechanism, because none is on file for him. A drug class named in the record does NOT license its gene: "baricitinib is a JAK inhibitor" is on file, "JAK2 signalling" is not. Name the drug and the effect, never the paralog. A genotype recorded as "no variant" is a negative result: never call it a hit, a variant or a risk allele. **Never total his genetic findings** — no "four genetic bone metabolism hits", no count of variants of any kind; name the specific genotypes that bear on the marker instead. **Never reverse or extend a recorded consequence**: the record says Factor XI deficiency carries bleeding risk after surgery or trauma, so it may not be written as a thrombosis interaction, even where area_notes does. Where he has recorded a hypothesis — as with VDR and VDBP — present it as his hypothesis with its pending panel. Where a marker has no reference range on file, make no normal-or-abnormal judgment, and never state a mechanism as established where no genotype or measurement backs it.
4. Close on what he should actually do or watch in this area, with the reasoning, and make it executable from this record: a lab or panel to draw, a protocol or dose decision, or a specific clinician conversation. Do not send him to a device, tracker or data source that does not appear in the record you were given. "Discuss with your physician", "consult a healthcare provider" and equivalents are prohibited as the substance of that. Naming a specific clinician conversation IS correct where that is the action.
5. If you cannot ground the paragraph in the record supplied, return that area as {"subject_id":"...","ungroundable":true} rather than writing something generic.`;

/**
 * The owner's record: conditions and the genetic block. Identical for every
 * subject in a run, so it is the cached prefix.
 *
 * Medications and protocols deliberately do NOT live here. They are marker-
 * linked in config, and AC 12 requires that changing one protocol leaves the
 * copy of unrelated markers alone. A global protocol block would put every
 * protocol in every subject's signature, so one dose edit would regenerate all
 * 55 markers. Conditions and genetics stay global because they are global: a
 * change to either legitimately re-frames every chart.
 */
export function buildHistoryBlock(db, uiConfig) {
  const lines = ['# Owner health record', '',
    'This is the complete record. A field that is not listed is not on file — do not supply it, do not estimate it, and do not describe it as unknown.', ''];

  const conditions = Array.isArray(uiConfig.conditionGroups) ? uiConfig.conditionGroups : [];
  if (conditions.length) {
    lines.push('## Conditions and standing focus areas');
    for (const group of conditions) {
      const name = cleanText(group.name);
      if (!name) continue;
      const desc = cleanText(group.desc);
      lines.push(desc ? `- ${name} — ${desc}` : `- ${name}`);
    }
    lines.push('');
  }

  let contextMd = '';
  try { contextMd = stmts(db).healthTopicContext.get()?.context_md || ''; } catch { contextMd = ''; }
  const genetics = extractGeneticFlags(contextMd);
  if (genetics) {
    lines.push('## Genetic record', '');
    lines.push(genetics.replace(/^### Genetic Flags\s*/, '').trim());
    lines.push('');
  }

  // Last, because last is what the model weighs most, and because these are the
  // facts he corrected most recently.
  const corrections = extractRecordCorrections(contextMd);
  if (corrections) {
    lines.push('## Corrections — these OVERRIDE anything above that contradicts them', '');
    lines.push(corrections.replace(/^###[^\n]*\n/, '').trim());
    lines.push('');
  }
  return lines.join('\n').trim();
}

function systemBlocks(rules, history) {
  // Anthropic caches on BLOCK boundaries and lib/llm/anthropic.js passes an
  // array system through untouched. A plain string system gets no caching at
  // all, silently: llmCreate never forwards a `cache` key, so applyCacheToSystem
  // returns a string system unchanged. cache_control therefore has to be
  // authored here, on the final block.
  return [
    { type: 'text', text: rules },
    { type: 'text', text: history, cache_control: { type: 'ephemeral' } },
  ];
}

function systemText(blocks) {
  return blocks.map(block => block.text).join('\n\n');
}

// ─── Signature + snapshot ─────────────────────────────────────────────────

/**
 * sha256 over exactly what a subject's prompt carries: the model id, the full
 * system text, and the subject's own payload. Anything in this hash the model
 * saw; anything the model saw is in this hash.
 */
export function computeInputSignature({ model, system, payload }) {
  return createHash('sha256')
    .update(JSON.stringify({ model, system, payload }))
    .digest('hex');
}

/**
 * Everything the model is told about a subject, for inspection and tests.
 * @returns {{ payload: object, fingerprint: object, signature: string, system: string }|null}
 */
export function describeSubject(db, subject) {
  const snapshot = buildCopySnapshot(db);
  const found = snapshot.subjects.find(s => s.scope === subject.scope && s.subject_id === subject.id);
  if (!found) return null;
  const blocks = subject.scope === 'area' ? snapshot.areaSystem : snapshot.markerSystem;
  return { payload: found.payload, signature: found.signature, system: systemText(blocks) };
}

function buildRunContext(db) {
  const uiConfig = healthUIConfig();
  const dbRecords = buildMarkerRecords(db);
  let medications = [];
  try { medications = listEffectiveMedicationsRaw(db); } catch { medications = []; }
  const stored = readCopyRows(db);

  // The chart pipeline decides both the generation set and what each chart
  // shows. Without a provider — a standalone script, a criteria check, a unit
  // test — fall back to the subjects already on file and to the database
  // records. That keeps computeStaleSubjects an honest determinism check
  // outside the server process: it re-derives every stored subject's
  // fingerprint from the database and compares, rather than trivially
  // returning nothing.
  let chartMarkers = [];
  if (chartSubjectProvider) {
    try { chartMarkers = chartSubjectProvider() || []; } catch (err) {
      console.warn(`[health-marker-copy] chart subject provider failed: ${err.message}`);
      chartMarkers = [];
    }
  }
  const chartRecords = new Map();
  for (const marker of chartMarkers) {
    const record = recordFromChartMarker(marker);
    if (record.subject_id) chartRecords.set(record.subject_id, record);
  }

  let markerIds = chartRecords.size
    ? [...chartRecords.keys()]
    : [...stored.values()].filter(row => row.scope === 'marker').map(row => row.subject_id);
  // A subject with no health_markers row cannot be fingerprinted, so it cannot
  // participate in selective regeneration and is left out rather than written
  // with a signature nothing can reproduce.
  markerIds = [...new Set(markerIds.filter(id => dbRecords.has(id)))].sort();

  // An area earns a narrative when at least one of its configured markers is in
  // the generation set. Sleep charts nothing, so it drops out on its own rather
  // than through a hardcoded exclusion.
  const areaMap = uiConfig.bodyAreaMap && typeof uiConfig.bodyAreaMap === 'object' ? uiConfig.bodyAreaMap : {};
  const areaIds = Object.keys(areaMap)
    .filter(areaId => (areaMap[areaId].markers || []).some(id => markerIds.includes(id)));

  return {
    uiConfig,
    dbRecords,
    records: chartRecords.size ? chartRecords : dbRecords,
    medications,
    stored,
    markerIds,
    areaIds,
  };
}

/**
 * Assemble every subject's payload and signature for this corpus. No writes, no
 * model calls, no side effects.
 */
function buildCopySnapshot(db) {
  const ctx = buildRunContext(db);
  const markerSystem = systemBlocks(MARKER_RULES, buildHistoryBlock(db, ctx.uiConfig));
  const areaSystem = systemBlocks(AREA_RULES, buildHistoryBlock(db, ctx.uiConfig));
  const markerSystemText = systemText(markerSystem);
  const areaSystemText = systemText(areaSystem);

  const subjects = [];
  const add = (scope, id, system) => {
    const subject = { scope, id };
    const payload = buildSubjectObject(subject, ctx, ctx.records);
    const fingerprint = buildSubjectFingerprint(subject, ctx);
    if (!payload || !fingerprint) return;
    subjects.push({
      scope,
      subject_id: id,
      payload,
      signature: computeInputSignature({ model: MARKER_COPY_MODEL, system, payload: fingerprint }),
    });
  };
  for (const id of ctx.markerIds) add('marker', id, markerSystemText);
  for (const id of ctx.areaIds) add('area', id, areaSystemText);
  return { ...ctx, subjects, markerSystem, areaSystem };
}

function rowKey(scope, subjectId) {
  return `${scope}${subjectId}`;
}

/**
 * Is a subject due for regeneration?
 *
 * Two ways in. Its input moved — the normal path. Or its stored row is a
 * FAILURE, in which case it is due whatever the signature says: a row written
 * because the provider rate-limited or timed out is not a settled result, and
 * treating it as one strands it forever, because the input never moves again.
 * Checking the reason rather than only the signature also repairs rows written
 * before that lesson was learned.
 */
const SETTLED_OMISSION_REASONS = new Set(['insufficient_readings', 'no_measurement_of_its_own']);

function subjectIsStale(row, subject) {
  if (!row) return true;
  // Only a DETERMINISTIC omission is a settled result. generation_failed,
  // ungroundable and incomplete_result all mean the run did not produce usable
  // copy, and each must be retried whatever the signature says — otherwise a
  // provider error or a one-off bad answer freezes into a permanent blank,
  // because the input never moves again.
  if (row.omitted && !SETTLED_OMISSION_REASONS.has(row.omitted_reason)) return true;
  return row.input_signature !== subject.signature;
}

function readCopyRows(db) {
  const map = new Map();
  for (const row of listHealthMarkerCopyRows(db)) map.set(rowKey(row.scope, row.subject_id), row);
  return map;
}

/**
 * The subjects whose input moved since their stored copy was written.
 * Zero writes, zero model calls — which is what makes "reloading without a data
 * change returns identical copy" checkable without spending tokens.
 * @returns {Array<{ scope: string, subject_id: string }>}
 */
export function computeStaleSubjects(db) {
  const snapshot = buildCopySnapshot(db);
  const stale = [];
  for (const subject of snapshot.subjects) {
    const row = snapshot.stored.get(rowKey(subject.scope, subject.subject_id));
    if (subjectIsStale(row, subject)) {
      stale.push({ scope: subject.scope, subject_id: subject.subject_id });
    }
  }
  return stale;
}

// ─── Generation ───────────────────────────────────────────────────────────

function extractJsonObject(text) {
  const stripped = String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(stripped.slice(start, end + 1)); } catch { return null; }
}

/**
 * Map results by subject_id, NEVER by array position. Position-keying is how one
 * marker's interpretation gets written onto another with full confidence when a
 * model returns fewer entries than requested or reorders them.
 */
/**
 * Human gene symbols this domain's copy plausibly reaches for. Deliberately a
 * vocabulary rather than a regex: a general "looks like a gene" pattern cannot
 * tell HFE from CBC, TTC, DFI or LDL, and stripping those would gut the prose.
 *
 * This is the mechanism behind AC 13, not the prompt. Prompt rule 3 forbids
 * naming a gene that is not on file, and it works most of the time — but the
 * record says baricitinib is a "JAK inhibitor", and on the first pass the model
 * read that as licence to write "JAK2 signalling" and "JAK1 suppression" on
 * three markers. A rule the model can rationalise around needs a check that
 * cannot be rationalised around.
 */
const KNOWN_GENE_SYMBOLS = [
  'ABCB1', 'ABCG2', 'ACAT1', 'ADH1B', 'AHCY', 'ALDH2', 'ALPL', 'APOE', 'BHMT', 'CBS',
  'CETP', 'CLDN14', 'COMT', 'CYP1A2', 'CYP24A1', 'CYP2C19', 'CYP2D6', 'CYP2R1', 'CYP3A4',
  'DHCR7', 'DPYD', 'F11', 'FANCG', 'G6PD', 'GSTM1', 'HAMP', 'HFE', 'HLA', 'IL6',
  'JAK1', 'JAK2', 'JAK3', 'LDLR', 'MAOA', 'MTHFR', 'MTR', 'MTRR', 'NAT2', 'NOD2',
  'PCSK9', 'PON1', 'SHMT1', 'SLC22A12', 'SLC34A1', 'SLCO1B1', 'TNFRSF1A', 'TPMT',
  'TYK2', 'UGT1A1', 'VDR', 'VKORC1',
];

/**
 * Gene symbols asserted in generated text that the owner's record does not
 * carry. Case-sensitive whole-token match: "JAK inhibitor" is the drug class and
 * passes; "JAK2" is the paralog and does not.
 */
export function forbiddenGeneMentions(text, record) {
  const body = String(text || '');
  const source = String(record || '');
  return KNOWN_GENE_SYMBOLS.filter(symbol => {
    if (source.includes(symbol)) return false;
    return new RegExp(`\\b${symbol}\\b`).test(body);
  });
}

/**
 * Genetic claims a symbol allowlist structurally cannot catch, because every
 * symbol involved IS on file. Two shapes, both observed shipping:
 *
 *   A TOTAL — "four genetic bone metabolism hits". The record carries VDR Bsm
 *   TT as a variant, VDR Taq GG as explicitly NO variant, VDR Apa1 AA, VDBP
 *   under a do-not-state-a-direction caution, CYP24A1 CT and CYP2R1 GG.
 *   Counting them produces a number the record does not support, and the count
 *   silently promotes a negative result into a finding. There is no arithmetic
 *   that makes a total safe here, so totals are simply not allowed.
 *
 *   AN INVERTED CONSEQUENCE — the record states Factor XI deficiency carrier,
 *   "bleeding risk after surgery or trauma". A row shipped asserting an F11
 *   thrombosis interaction, which is the opposite direction, and contradicted
 *   its own Definition in the same block. F11 is the only coagulation gene on
 *   file, so this check is deliberately narrow rather than a general attempt to
 *   compute the opposite of an arbitrary mechanism.
 */
export function unsupportedGeneticClaims(text) {
  const body = String(text || '');
  const found = [];
  const total = body.match(/\b(two|three|four|five|six|seven|eight|nine|ten|\d+)\b[^.]{0,40}?\b(genetic|gene|variant|snp|polymorphism)\w*\b[^.]{0,30}?\b(hits?|findings?|variants?|mutations?|markers?)\b/i)
    || body.match(/\b(two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(recorded\s+|confirmed\s+|owner-stated\s+)?(genetic|gene)\b/i);
  if (total) found.push(`counts genetic findings: "${total[0].trim()}"`);
  // Sentence-scoped, and matching the clinical name as well as the symbol — a
  // check the model sidesteps by writing "Factor XI" is not a check.
  //
  // It fires only where the carrier finding itself is tied to clotting with no
  // mention of bleeding in the same sentence. "baricitinib carries a thrombosis
  // monitoring obligation, and your Factor XI status adds a bleeding-risk layer"
  // is correct — thrombosis belongs to the JAK inhibitor, bleeding to F11 — and
  // must not be flagged.
  for (const sentence of body.split(/(?<=[.!?])\s+/)) {
    if (!/\b(F11|Factor XI)\b/i.test(sentence)) continue;
    if (!/thrombo(sis|tic|embol)/i.test(sentence)) continue;
    if (/bleed|haemorrhag|hemorrhag/i.test(sentence)) continue;
    found.push('Factor XI (F11) is a bleeding-risk carrier finding; the record states bleeding risk after surgery or trauma, not a thrombosis interaction');
    break;
  }
  return found;
}

/**
 * The things a Definition can name that make it his rather than a textbook's:
 * a condition he carries, a drug or protocol he takes, a gene on file, or his
 * own target for this marker.
 *
 * Condition NAMES, not their focus text — "copper deficiency" appears inside the
 * iron group's description, and a Definition that mentions copper without ever
 * naming the group, the gene or the target still reads identically for anyone.
 */
function definitionAnchors(payload, record) {
  const anchors = [];
  const words = text => String(text || '')
    .split(/[^A-Za-z0-9'\u00C0-\u024F]+/)
    .filter(w => w.length >= 4 && !GENERIC_CLINICAL_WORDS.has(w.toLowerCase()));
  for (const condition of payload?.linked_conditions || []) {
    anchors.push(...words(condition.name), ...words(condition.focus));
  }
  for (const protocol of payload?.linked_protocols || []) anchors.push(...words(protocol.name));
  for (const medication of payload?.linked_medications || []) anchors.push(...words(medication.name));
  for (const symbol of KNOWN_GENE_SYMBOLS) if (String(record || '').includes(symbol)) anchors.push(symbol);
  if (payload?.target != null) anchors.push(String(payload.target));
  return [...new Set(anchors)];
}

/**
 * Words that appear in his record but individuate nothing. Without this filter
 * "exposure" in the toxicology group's description would license a Definition
 * that says "reflects recent exposure" — a sentence true of every toxicant
 * marker on earth, which is exactly what AC 4 rejects.
 */
const GENERIC_CLINICAL_WORDS = new Set([
  'exposure', 'monitoring', 'monitor', 'prevention', 'risk', 'risks', 'disease',
  'activity', 'function', 'status', 'health', 'management', 'response',
  'control', 'decline', 'levels', 'level', 'marker', 'markers', 'count',
  'counts', 'cell', 'cells', 'test', 'tests', 'result', 'results', 'value',
  'values', 'range', 'ranges', 'panel', 'blood', 'serum', 'plasma', 'urine',
  'total', 'normal', 'high', '低', 'with', 'from', 'this', 'that', 'your',
]);

/**
 * AC 4's stated test, made mechanical: "a sentence that would read identically
 * for any other person fails this criterion." Six of 55 Definitions shipped as
 * pure physiology — TSH as the pituitary signal, chloride as the major
 * extracellular anion — true, useful to a student, and not about him.
 *
 * Anchors include a condition's focus text, not just its config label: he does
 * not call it "Primary Autoimmune", he calls it vasculitis, flares and
 * complement consumption, and that is the vocabulary the copy should use.
 */
export function definitionLacksPersonalAnchor(definition, payload, record) {
  const body = String(definition || '');
  if (!body.trim()) return true;
  const anchors = definitionAnchors(payload, record);
  if (!anchors.length) return false;
  return !anchors.some(anchor => new RegExp(`\\b${anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(body));
}

export function parseModelResults(text) {
  const parsed = extractJsonObject(text);
  if (!parsed) return null;
  const map = new Map();
  const list = Array.isArray(parsed.results) ? parsed.results : [];
  for (const entry of list) {
    const id = cleanText(entry?.subject_id);
    if (!id) continue;
    map.set(id, entry);
  }
  return map;
}

async function callModel(blocks, payloads, maxTokens, label) {
  const resp = await llmCreate({
    model: MARKER_COPY_MODEL,
    max_tokens: maxTokens,
    system: blocks,
    messages: [{ role: 'user', content: JSON.stringify({ subjects: payloads }, null, 2) }],
    timeout_ms: MARKER_COPY_TIMEOUT_MS,
  }, label);
  const text = (resp.content || [])
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join('');
  return parseModelResults(text) || new Map();
}

/**
 * One batch, with a single retry. A subject still missing after the retry is
 * written as omitted with reason generation_failed — a loud, queryable failure
 * rather than a blank row the owner cannot interpret.
 */
function entryText(entry) {
  return [entry?.definition, entry?.trend, entry?.action, entry?.narrative].filter(Boolean).join(' ');
}

async function runBatch(blocks, batch, maxTokens, label) {
  const recordText = systemText(blocks);
  let results = new Map();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const attemptResults = await callModel(blocks, batch.map(subject => subject.payload), maxTokens, label);
      for (const [id, entry] of attemptResults) if (!results.has(id)) results.set(id, entry);
    } catch (err) {
      console.warn(`[health-marker-copy] ${label} attempt ${attempt + 1} failed: ${err.message}`);
    }
    if (batch.every(subject => results.has(subject.subject_id))) break;
  }

  // Grounding enforcement, in code. A subject whose prose breaks a rule the
  // code can check gets ONE corrective call naming the exact breach; anything
  // still violating becomes ungroundable rather than shipping. That path fails
  // the build by design (AC 8 asserts zero omissions), so a persistent
  // violation surfaces loudly instead of reaching the owner.
  const offences = new Map();
  for (const subject of batch) {
    const violations = groundingViolations(results.get(subject.subject_id), subject.payload, recordText);
    if (violations.length) offences.set(subject.subject_id, violations);
  }
  if (!offences.size) return results;

  const offenders = batch.filter(subject => offences.has(subject.subject_id));
  const summary = [...new Set([...offences.values()].flat().map(v => v.message))];
  console.warn(`[health-marker-copy] ${label} grounding violations (${summary.join(' | ')}) — re-asking ${offenders.length} subject(s)`);
  const corrective = [
    ...blocks.slice(0, -1),
    { ...blocks[blocks.length - 1], cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `CORRECTION: your previous answer broke these rules. Rewrite these subjects without repeating any of them.\n${offenders.map(s => `- ${s.subject_id}: ${offences.get(s.subject_id).map(v => v.message).join('; ')}`).join('\n')}` },
  ];

  // Severity decides what a persistent violation costs.
  //
  // A SAFETY breach — a gene not on file, a total of his genetic findings, a
  // recorded consequence written backwards — is a claim about his body that the
  // record does not support, so the subject ships as ungroundable and the build
  // fails loudly (AC 8 asserts zero omissions).
  //
  // A QUALITY miss — a Definition that reads like a textbook — is worse copy,
  // not a false claim. Blanking the chart over it leaves him with nothing where
  // he had something imperfect, so the retried text is kept and the miss is
  // logged. Four blood markers hit exactly this on the previous run.
  const persists = (entry, subject) => groundingViolations(entry, subject.payload, recordText);
  try {
    const retried = await callModel(corrective, offenders.map(subject => subject.payload), maxTokens, `${label}-grounding-correction`);
    for (const subject of offenders) {
      const entry = retried.get(subject.subject_id) || results.get(subject.subject_id);
      const remaining = persists(entry, subject);
      if (!remaining.length) { results.set(subject.subject_id, entry); continue; }
      if (remaining.some(v => v.severity === 'safety')) {
        results.set(subject.subject_id, { subject_id: subject.subject_id, ungroundable: true });
        continue;
      }
      console.warn(`[health-marker-copy] ${subject.subject_id} still generic after correction — keeping it: ${remaining.map(v => v.message).join('; ')}`);
      results.set(subject.subject_id, entry);
    }
  } catch (err) {
    console.warn(`[health-marker-copy] ${label} grounding correction failed: ${err.message}`);
    for (const subject of offenders) {
      if (offences.get(subject.subject_id).some(v => v.severity === 'safety')) {
        results.set(subject.subject_id, { subject_id: subject.subject_id, ungroundable: true });
      }
    }
  }
  return results;
}

/**
 * Every grounding rule the code can check, in one place, returned as
 * plain-language breaches the corrective call can quote back.
 */
export function groundingViolations(entry, payload, recordText) {
  if (!entry || entry.ungroundable === true) return [];
  const text = entryText(entry);
  const violations = [];
  const genes = forbiddenGeneMentions(text, recordText);
  if (genes.length) violations.push({ severity: 'safety', message: `names ${genes.join(', ')}, which are not on file` });
  for (const message of unsupportedGeneticClaims(text)) violations.push({ severity: 'safety', message });
  if (entry.definition && definitionLacksPersonalAnchor(entry.definition, payload, recordText)) {
    violations.push({ severity: 'quality', message: 'the Definition names no condition, drug, protocol, gene or target of his — it would read identically for anyone' });
  }
  return violations;
}

export function markerRowFromResult(subject, entry) {
  const definition = cleanText(entry?.definition);
  const trend = cleanText(entry?.trend);
  const action = cleanText(entry?.action);
  if (!entry) {
    return { omitted: 1, omitted_reason: 'generation_failed', definition: '', trend: '', action: '', narrative: '' };
  }
  // An ungroundable subject, and any subject that came back with a blank field,
  // becomes an omitted row rather than an empty row on the chart.
  if (entry.ungroundable === true || !definition || !trend || !action) {
    return {
      omitted: 1,
      omitted_reason: entry.ungroundable === true ? 'ungroundable' : 'incomplete_result',
      definition: '', trend: '', action: '', narrative: '',
    };
  }
  return { omitted: 0, omitted_reason: '', definition, trend, action, narrative: '' };
}

/**
 * Shape one area narrative for the single div that renders it: collapse
 * whitespace, hold the render budget, and close the last sentence.
 *
 * The closing rule earns its place. Asked for at most 520 characters, the model
 * sometimes stops on a trailing ";" or "," to stay inside the budget, which
 * renders as a paragraph that trails off. Prompting alone does not fix it — it
 * only moves which paragraph it lands on — so the last clause is closed
 * deterministically here. Applied on both the write and read paths so a row
 * stored before this rule existed still renders correctly.
 */
export function normalizeAreaNarrative(text) {
  const clean = cleanText(text).replace(/\s+/g, ' ');
  if (!clean) return '';

  if (clean.length > AREA_NARRATIVE_MAX_CHARS) {
    const slice = clean.slice(0, AREA_NARRATIVE_MAX_CHARS);
    const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
    // Any sentence boundary beats a hard cut, wherever it falls. The old rule
    // required one past 60% of the budget and fell through to a raw character
    // slice otherwise — which shipped the heart narrative ending "at this d."
    // and then glued a period on, so a mid-word cut read as a finished thought.
    if (sentence > 0) return slice.slice(0, sentence + 1).trimEnd();
    // No sentence boundary at all: cut on a WORD boundary and mark it elided.
    // A hard truncation must never be dressed up as a completed sentence.
    const word = slice.lastIndexOf(' ');
    return `${(word > 0 ? slice.slice(0, word) : slice).replace(/[;:,—–-]+$/, '').trimEnd()}…`;
  }

  // Untruncated text that stopped on a separator gets its last clause closed.
  return /[.!?…]$/.test(clean) ? clean : `${clean.replace(/[;:,—–-]+$/, '').trimEnd()}.`;
}

function areaRowFromResult(entry) {
  if (!entry) {
    return { omitted: 1, omitted_reason: 'generation_failed', definition: '', trend: '', action: '', narrative: '' };
  }
  const narrative = normalizeAreaNarrative(entry?.narrative);
  if (entry.ungroundable === true || !narrative) {
    return {
      omitted: 1,
      omitted_reason: entry.ungroundable === true ? 'ungroundable' : 'incomplete_result',
      definition: '', trend: '', action: '', narrative: '',
    };
  }
  return { omitted: 0, omitted_reason: '', definition: '', trend: '', action: '', narrative };
}

function writeRow(db, subject, row) {
  // A row that failed for infrastructure reasons is stored with NO signature, so
  // the next run sees it as stale and retries. Storing the real signature would
  // freeze a transient provider error — a rate limit, a timeout, a 500 — into a
  // permanent omission that never regenerates, because the input never moves
  // again. Learned the hard way: an API quota ceiling hit mid-run wrote seven
  // area narratives as settled failures.
  const signature = row.omitted_reason === 'generation_failed' ? '' : subject.signature;
  stmts(db).upsertCopy.run({
    scope: subject.scope,
    subject_id: subject.subject_id,
    definition: row.definition || '',
    trend: row.trend || '',
    action: row.action || '',
    narrative: row.narrative || '',
    omitted: row.omitted ? 1 : 0,
    omitted_reason: row.omitted_reason || '',
    input_signature: signature,
    model: MARKER_COPY_MODEL,
  });
}

/**
 * A model call that never returned must not blank copy that is already good.
 * When there is no result for a subject and a usable row is already stored, the
 * stored row is left exactly where it is — with its old signature, so it stays
 * stale and is retried on the next run. Only a subject with nothing worth
 * keeping is written as a failure.
 */
function shouldPreserveStoredRow(snapshot, subject, entry) {
  if (entry) return false;
  const stored = snapshot.stored.get(rowKey(subject.scope, subject.subject_id));
  return Boolean(stored && !stored.omitted);
}

/**
 * Regenerate the generated copy for every subject whose input moved.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ force?: boolean }} options force rewrites every subject, ignoring
 *        the signature diff. Used only when the prompt itself changed.
 * @returns {Promise<object>} run stats
 */
export async function regenerateHealthMarkerCopy(db, { force = false } = {}) {
  // Snapshot every input ONCE, up front. A run that re-reads the corpus between
  // batches can hash one version of a marker and write prose about another.
  const snapshot = buildCopySnapshot(db);
  const stats = {
    model: MARKER_COPY_MODEL,
    total: snapshot.subjects.length,
    unchanged: 0,
    generated: 0,
    omitted: 0,
    preserved: 0,
    failed: 0,
  };

  const targets = snapshot.subjects.filter(subject => {
    const row = snapshot.stored.get(rowKey(subject.scope, subject.subject_id));
    const moved = subjectIsStale(row, subject);
    if (!moved && !force) stats.unchanged += 1;
    return moved || force;
  });

  if (!targets.length) {
    console.info('[health-marker-copy] nothing to regenerate — every subject signature matched');
    return stats;
  }

  // Tier 0: the omission rule fires before any model call, so an omitted subject
  // costs zero tokens and is stored with its signature so it does not re-enter
  // the batch on the next run.
  const generateSubjects = [];
  for (const subject of targets) {
    if (subject.scope !== 'marker') { generateSubjects.push(subject); continue; }
    const omission = markerCopyOmission(subject.payload);
    if (!omission.omitted) { generateSubjects.push(subject); continue; }
    writeRow(db, subject, { ...omission, definition: '', trend: '', action: '', narrative: '' });
    stats.omitted += 1;
  }

  const markerTargets = generateSubjects.filter(subject => subject.scope === 'marker');
  const areaTargets = generateSubjects.filter(subject => subject.scope === 'area');

  for (let i = 0; i < markerTargets.length; i += MARKER_COPY_BATCH_SIZE) {
    const batch = markerTargets.slice(i, i + MARKER_COPY_BATCH_SIZE);
    const results = await runBatch(snapshot.markerSystem, batch, MARKER_MAX_OUTPUT_TOKENS, 'health-marker-copy');
    for (const subject of batch) {
      const entry = results.get(subject.subject_id);
      if (shouldPreserveStoredRow(snapshot, subject, entry)) { stats.preserved += 1; continue; }
      const row = markerRowFromResult(subject, entry);
      writeRow(db, subject, row);
      if (row.omitted) stats.failed += 1; else stats.generated += 1;
    }
  }

  if (areaTargets.length) {
    const results = await runBatch(snapshot.areaSystem, areaTargets, AREA_MAX_OUTPUT_TOKENS, 'health-area-narrative');
    for (const subject of areaTargets) {
      const entry = results.get(subject.subject_id);
      if (shouldPreserveStoredRow(snapshot, subject, entry)) { stats.preserved += 1; continue; }
      const row = areaRowFromResult(entry);
      writeRow(db, subject, row);
      if (row.omitted) stats.failed += 1; else stats.generated += 1;
    }
  }

  console.info('[health-marker-copy] run complete:', JSON.stringify(stats));
  if (payloadRefresher) {
    try { payloadRefresher({ reason: 'health_marker_copy_regenerated' }); }
    catch (err) { console.warn(`[health-marker-copy] payload refresh failed: ${err.message}`); }
  }
  return stats;
}
