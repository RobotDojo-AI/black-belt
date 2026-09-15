#!/usr/bin/env node
import vm from 'node:vm';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import db from '../../lib/db.js';

const repo = resolve(import.meta.dirname, '../..');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = Number(limitArg?.split('=')[1] || 50);
const json = process.argv.includes('--json');

function loadViewerInternals() {
  const window = {
    location: { pathname: '/', origin: 'http://viewer.test', href: 'http://viewer.test/' },
    RobotDojoComponents: { markdownHtml: (text) => String(text || '') },
    esc: (value) => String(value ?? ''),
  };
  const context = {
    window,
    document: {
      addEventListener() {},
      body: { classList: { add() {} } },
      getElementById() { return null; },
      title: '',
    },
    navigator: { clipboard: { writeText: async () => {} } },
    URL,
    Date,
    console,
    setTimeout,
    clearTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(readFileSync(resolve(repo, 'apps/viewer/app.js'), 'utf8'), context);
  return context.window.RobotDojoViewerInternals;
}

function resolveContextPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2));
  if (raw.startsWith('/')) return raw;
  return resolve(repo, raw);
}

function topPeople() {
  return db.prepare(`
    SELECT 'people' AS entityType, display_name AS title, context_file_path,
      COALESCE(score, 0) AS rankScore, COALESCE(interaction_count, 0) AS interactions
    FROM people
    WHERE COALESCE(archived, 0) = 0 AND context_file_path IS NOT NULL
    ORDER BY COALESCE(score, 0) DESC, COALESCE(interaction_count, 0) DESC, LOWER(display_name)
    LIMIT ?
  `).all(limit);
}

function topCompanies() {
  return db.prepare(`
    SELECT 'companies' AS entityType, name AS title, context_file_path,
      COALESCE(people_count, 0) AS rankScore
    FROM companies
    WHERE COALESCE(archived, 0) = 0 AND context_file_path IS NOT NULL
    ORDER BY COALESCE(people_count, 0) DESC, LOWER(name)
    LIMIT ?
  `).all(limit);
}

function topPlaces() {
  return db.prepare(`
    SELECT 'places' AS entityType, name AS title, context_file_path,
      COALESCE(total_visits, frequency, 0) AS rankScore,
      last_seen
    FROM places
    WHERE COALESCE(archived, 0) = 0 AND context_file_path IS NOT NULL
    ORDER BY (COALESCE(total_visits, frequency, 0) * CASE
      WHEN julianday('now') - julianday(COALESCE(last_seen,'2000-01-01')) < 30  THEN 1.0
      WHEN julianday('now') - julianday(COALESCE(last_seen,'2000-01-01')) < 90  THEN 0.75
      WHEN julianday('now') - julianday(COALESCE(last_seen,'2000-01-01')) < 180 THEN 0.5
      WHEN julianday('now') - julianday(COALESCE(last_seen,'2000-01-01')) < 365 THEN 0.3
      ELSE 0.15
    END) DESC, last_seen DESC, LOWER(name)
    LIMIT ?
  `).all(limit);
}

function normalize(value) {
  return String(value || '')
    .replace(/^#+\s+.+$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function startsDuplicate(currentRead, workingBrief) {
  const current = normalize(currentRead).toLowerCase();
  const brief = normalize(workingBrief).toLowerCase();
  const probe = current.slice(0, Math.min(160, current.length));
  return probe.length >= 80 && brief.slice(0, 700).includes(probe);
}

function machineTrace(text) {
  return /imported (?:company\/vendor|email or vendor-domain) trace|contact artifact|captured (?:automated|newsletter|digest|Zoom|scheduling|web link)/i.test(text);
}

function auditModel(row, model) {
  const current = String(model.currentRead || '');
  const brief = String(model.workingBrief || '');
  const joined = `${current}\n\n${brief}`;
  const failures = [];

  if (normalize(current).length < 80) failures.push('short_1k');
  if (normalize(brief).length < 100) failures.push('short_4k');
  if (startsDuplicate(current, brief)) failures.push('4k_repeats_1k');
  if (/\*\*(Type|Company|Visits|Address|Industry|People|Vertical):\*\*/i.test(joined)) failures.push('field_card');
  if (/\b(?:description|website|funding_stage|total_raised|lead_investors|employee_range|linkedin_url|current_role|twitter):\s/i.test(joined)) failures.push('raw_metadata');
  if (/Key Contacts|structured data only|database (?:row|card|readout)|Low-signal entity/i.test(joined)) failures.push('database_language');
  if (/\(the user\)|\bwith you is classified\b|\bclassified as (?:Core|Network|Family|Professional|Personal|Acquaintance)\b/i.test(joined)) failures.push('pronoun_artifact');
  if (/memory_projection|source_event_|source_set_hash|source records|Continue from the newest source-backed synthesis/i.test(joined)) failures.push('source_noise');
  if (/^\s*[-*]\s+\S+@\S+/im.test(brief)) failures.push('email_bullet_4k');
  if (!machineTrace(joined) && (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(joined) || /(?:\+\d{10,}|\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)/.test(joined))) failures.push('contact_artifact');
  if (/^##\s+.+/m.test(brief) && !/\b(you|your)\b/i.test(normalize(brief).slice(0, 320)) && row.entityType !== 'places') failures.push('detached_4k_heading');

  if (row.entityType === 'companies' && !machineTrace(joined)) {
    if (/company radar|linked (?:person|people)|company map/i.test(current)) failures.push('generic_company_1k');
    if (/A deeper company read .* is not source-backed yet/i.test(brief)) failures.push('generic_company_4k');
  }

  if (row.entityType === 'people' && !machineTrace(joined)) {
    if (/currently appears in your network|is present in your network|provisional read|Treat this as/i.test(joined)) failures.push('generic_person_language');
    if (/^##\s+.+/m.test(brief) && /^[A-Z][\w'’.-]+.{0,220}\b(?:is|appears|serves|representative|member|founder)\b/i.test(normalize(brief))) failures.push('bio_first_4k');
  }

  return failures;
}

function auditRow(viewer, row) {
  const path = resolveContextPath(row.context_file_path);
  if (!path || !existsSync(path)) {
    return { ...row, path, failures: ['missing_context_file'] };
  }
  const body = readFileSync(path, 'utf8');
  const model = viewer.buildViewerPageModel({
    kind: 'entity',
    entityType: row.entityType,
    title: row.title,
    relPath: row.context_file_path,
  }, body);
  const failures = auditModel(row, model);
  return {
    ...row,
    title: model.title || row.title,
    path,
    failures,
    currentRead: model.currentRead,
    workingBrief: model.workingBrief,
  };
}

const viewer = loadViewerInternals();
const rows = [...topPeople(), ...topCompanies(), ...topPlaces()];
const results = rows.map((row) => auditRow(viewer, row));
const failed = results.filter((result) => result.failures.length);

if (json) {
  console.log(JSON.stringify({
    ok: failed.length === 0,
    checked: results.length,
    byType: rows.reduce((acc, row) => {
      acc[row.entityType] = (acc[row.entityType] || 0) + 1;
      return acc;
    }, {}),
    failed: failed.map((item) => ({
      type: item.entityType,
      title: item.title,
      rankScore: item.rankScore,
      context_file_path: item.context_file_path,
      failures: item.failures,
      currentSample: normalize(item.currentRead).slice(0, 220),
      briefSample: normalize(item.workingBrief).slice(0, 220),
    })),
  }, null, 2));
} else {
  console.log(`viewer top-entity humanity audit: checked ${results.length}, failed ${failed.length}`);
  for (const item of failed.slice(0, 40)) {
    console.log(`- ${item.entityType}: ${item.title} — ${item.failures.join(', ')}`);
  }
}

if (failed.length) process.exitCode = 1;
