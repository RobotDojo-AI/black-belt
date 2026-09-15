import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HEALTH_UI_PATH = resolve(__dirname, '..', 'config', 'health-ui.json');

function readHealthUiConfig() {
  try {
    return JSON.parse(readFileSync(HEALTH_UI_PATH, 'utf8'));
  } catch {
    return { rxGroups: [] };
  }
}

export function healthUiConfigUpdatedAt() {
  try {
    return statSync(HEALTH_UI_PATH).mtime.toISOString();
  } catch {
    return null;
  }
}

function slugFor(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'medication';
}

function inferStartedDate(name, desc) {
  const text = `${name || ''} ${desc || ''}`;
  const lower = text.toLowerCase();
  if (/started\s+2020/.test(lower)) return '2020-01-01';
  if (/started\s+feb(?:ruary)?\s+2026/.test(lower)) return '2026-02-01';
  if (/\bdec(?:ember)?\s+2025\b/.test(lower)) return '2025-12-01';
  if (/\bjuly\s+2025\b/.test(lower)) return '2025-07-01';
  if (/\bmay[-–]\s*sept\s+2025\b|\bmay\s*-\s*sept\s+2025\b/.test(lower)) return '2025-05-01';
  return '';
}

function inferDose(desc) {
  const matches = String(desc || '').match(/\b\d+(?:\.\d+)?\s*mg\b/gi);
  return matches?.length ? matches[matches.length - 1].replace(/\s+/g, ' ') : '';
}

function inferFrequency(desc) {
  const text = String(desc || '').toLowerCase();
  if (/\beow\b|every other week/.test(text)) return 'every other week';
  if (/\bdaily\b/.test(text)) return 'daily';
  return '';
}

function cleanField(value) {
  return value == null ? '' : String(value).trim();
}

export function medicationRowsFromHealthOntology() {
  const cfg = readHealthUiConfig();
  const rxGroups = Array.isArray(cfg.rxGroups) ? cfg.rxGroups : [];
  return rxGroups.map(group => {
    const name = String(group.name || '').trim();
    const desc = String(group.desc || '').trim();
    const slug = slugFor(name);
    return {
      id: `ontology:${slug}`,
      name,
      type: cleanField(group.type) || (/supplement/i.test(name) ? 'supplement' : 'rx'),
      dose: cleanField(group.dose) || inferDose(desc),
      frequency: cleanField(group.frequency) || inferFrequency(desc),
      timing: cleanField(group.timing),
      date_started: cleanField(group.date_started) || inferStartedDate(name, desc),
      date_stopped: cleanField(group.date_stopped),
      status: cleanField(group.status) || 'active',
      notes: desc,
      updated_at: healthUiConfigUpdatedAt() || '',
      source: 'health_rx_ontology',
      marker_ids: Array.isArray(group.markers) ? group.markers : [],
    };
  }).filter(row => row.name);
}

export function medicationOntologySignature() {
  return JSON.stringify(medicationRowsFromHealthOntology().map(row => ({
    name: row.name,
    type: row.type,
    dose: row.dose,
    frequency: row.frequency,
    timing: row.timing,
    date_started: row.date_started,
    date_stopped: row.date_stopped,
    status: row.status,
    notes: row.notes,
    marker_ids: row.marker_ids,
  })));
}

export function listEffectiveMedicationsRaw(database) {
  const rows = database.prepare('SELECT * FROM curated_medications ORDER BY status, name').all();
  if (rows.length) return rows.map(row => ({ ...row, source: row.source || 'curated_medications' }));
  return medicationRowsFromHealthOntology();
}
