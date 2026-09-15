import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getBackupOptions } from './backup-options.js';

export const HEALTH_RECOVERY_FLOOR = Object.freeze({
  active_points: 34296,
  oura_points: 17954,
  apple_health_points: 14074,
  fhir_persisted_points: 893,
  fhir_active_points: 846,
  pdf_lab_points: 1422,
  pdf_ingestion_log_entries: 110,
  markers: 609,
  min_date: '2002-08-15',
  max_date: '2026-05-01',
  pdf_vault_files: 115,
});

export const HEALTH_RECOVERY_PATHS = Object.freeze({
  pdfVault: 'user/databases/health/archive/labs',
  workbenchManifest: 'user/workbenches/topics/personal/health/wk_health/reports/pdf-extraction-2026-05-26.json',
});

function scalar(db, sql, key = 'n') {
  try {
    return db.prepare(sql).get()?.[key] ?? null;
  } catch {
    return null;
  }
}

function kvValue(db, key) {
  try {
    return db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key)?.value ?? null;
  } catch {
    return null;
  }
}

function backupTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.checked_at === 'string' && parsed.checked_at.trim()) return parsed.checked_at.trim();
    if (typeof parsed?.last_success === 'string' && parsed.last_success.trim()) return parsed.last_success.trim();
    if (typeof parsed?.lastSuccess === 'string' && parsed.lastSuccess.trim()) return parsed.lastSuccess.trim();
  } catch {
    // Plain ISO strings are the compatibility format for integration health.
  }
  return trimmed;
}

function backupOptionsWithDbHeartbeat(db, options) {
  const backup = options.backupOptions || getBackupOptions();
  const configuredSuccess = backupTimestamp(backup.last_success || backup.lastSuccess);
  if (configuredSuccess) return { ...backup, last_success: configuredSuccess };

  const heartbeat = backupTimestamp(kvValue(db, 'backup:last_success'))
    || backupTimestamp(kvValue(db, 'backup:last_success_detail'));
  if (!heartbeat) return backup;
  return {
    ...backup,
    last_success: heartbeat,
    heartbeat_source: 'kv_store',
  };
}

function countPdfFiles(dir) {
  try {
    return readdirSync(dir).filter(file => file.toLowerCase().endsWith('.pdf')).length;
  } catch {
    return 0;
  }
}

export function verifyPdfManifest(path) {
  if (!existsSync(path)) return { ok: false, path, error: 'missing' };
  try {
    const raw = readFileSync(path, 'utf8');
    const manifest = JSON.parse(raw);
    const stored = manifest.completion_hash;
    const { completion_hash: _, ...withoutHash } = manifest;
    const computed = createHash('sha256').update(JSON.stringify(withoutHash, null, 2)).digest('hex');
    return {
      ok: stored === computed,
      path,
      stored,
      computed,
      pdfs_total: manifest.post_run?.pdfs_total ?? null,
      pdfs_with_data: manifest.post_run?.pdfs_with_data ?? null,
      new_points_inserted: manifest.post_run?.new_points_inserted ?? null,
    };
  } catch (error) {
    return { ok: false, path, error: error.message };
  }
}

export function buildHealthRecoveryStatus(db, options = {}) {
  const repoRoot = options.repoRoot || join(homedir(), 'robotdojo');
  const pdfVault = options.pdfVault || join(repoRoot, HEALTH_RECOVERY_PATHS.pdfVault);
  const manifestPath = options.manifestPath || join(repoRoot, HEALTH_RECOVERY_PATHS.workbenchManifest);
  const floor = options.floor || HEALTH_RECOVERY_FLOOR;

  const dbCounts = {
    active_points: scalar(db, 'SELECT COUNT(*) AS n FROM health_data_points WHERE excluded = 0'),
    oura_points: scalar(db, "SELECT COUNT(*) AS n FROM health_data_points WHERE source = 'oura-json' AND excluded = 0"),
    apple_health_points: scalar(db, "SELECT COUNT(*) AS n FROM health_data_points WHERE source = 'apple-health' AND excluded = 0"),
    fhir_persisted_points: scalar(db, "SELECT COUNT(*) AS n FROM health_data_points WHERE source = 'fhir'"),
    fhir_active_points: scalar(db, "SELECT COUNT(*) AS n FROM health_data_points WHERE source = 'fhir' AND excluded = 0"),
    pdf_lab_points: scalar(db, "SELECT COUNT(*) AS n FROM health_data_points WHERE source = 'pdf-lab'"),
    pdf_ingestion_log_entries: scalar(db, "SELECT COUNT(*) AS n FROM health_ingestion_log WHERE source = 'pdf-lab'"),
    empty_source_ids: scalar(db, "SELECT COUNT(*) AS n FROM health_data_points WHERE source_id IS NULL OR source_id = ''"),
    legacy_pdf_points: scalar(db, "SELECT COUNT(*) AS n FROM health_data_points WHERE source = 'pdf'"),
    markers: scalar(db, 'SELECT COUNT(*) AS n FROM health_markers'),
    min_date: scalar(db, 'SELECT MIN(date) AS v FROM health_data_points WHERE excluded = 0', 'v'),
    max_date: scalar(db, 'SELECT MAX(date) AS v FROM health_data_points WHERE excluded = 0', 'v'),
  };

  const sourceFiles = {
    pdf_vault_path: pdfVault,
    pdf_vault_files: countPdfFiles(pdfVault),
  };

  const manifest = verifyPdfManifest(manifestPath);
  const backup = backupOptionsWithDbHeartbeat(db, options);
  const backupRecoverable = Boolean(
    backup.configured
    && !backup.skipped
    && (backup.recoverable || backup.last_success || backup.lastSuccess || options.allowConfiguredBackupOnly)
  );

  const checks = [
    checkAtLeast('active_points', dbCounts.active_points, floor.active_points),
    checkAtLeast('oura_points', dbCounts.oura_points, floor.oura_points),
    checkAtLeast('apple_health_points', dbCounts.apple_health_points, floor.apple_health_points),
    checkAtLeast('fhir_persisted_points', dbCounts.fhir_persisted_points, floor.fhir_persisted_points),
    checkAtLeast('fhir_active_points', dbCounts.fhir_active_points, floor.fhir_active_points),
    checkAtLeast('pdf_lab_points', dbCounts.pdf_lab_points, floor.pdf_lab_points),
    checkAtLeast('pdf_ingestion_log_entries', dbCounts.pdf_ingestion_log_entries, floor.pdf_ingestion_log_entries),
    checkEquals('empty_source_ids', dbCounts.empty_source_ids, 0),
    checkEquals('legacy_pdf_points', dbCounts.legacy_pdf_points, 0),
    checkAtLeast('markers', dbCounts.markers, floor.markers),
    checkDateAtOrBefore('min_date', dbCounts.min_date, floor.min_date),
    checkDateAtOrAfter('max_date', dbCounts.max_date, floor.max_date),
    checkAtLeast('pdf_vault_files', sourceFiles.pdf_vault_files, floor.pdf_vault_files),
    { name: 'pdf_manifest_integrity', ok: manifest.ok, actual: manifest.ok, expected: true },
    { name: 'backup_recoverable', ok: backupRecoverable, actual: backup, expected: 'fresh recoverable backup provider' },
  ];

  const missing = checks.filter(check => !check.ok).map(check => check.name);
  const recovery_mode = missing.length === 0 ? 'backup-first-ready' : 'restore-required';

  return {
    ok: missing.length === 0,
    recovery_mode,
    missing,
    db: dbCounts,
    source_files: sourceFiles,
    manifest,
    backup: {
      provider: backup.provider,
      configured: backup.configured,
      skipped: backup.skipped,
      last_success: backup.last_success,
      last_error: backup.last_error,
      heartbeat_source: backup.heartbeat_source,
    },
    checks,
    restore_order: [
      'Restore database files from backup first.',
      'Restore health source files if missing.',
      'Verify this status report.',
      'Run source imports only for missing layers.',
      'Run PDF extraction only as the last resort after explicit owner approval.',
    ],
  };
}

function checkAtLeast(name, actual, expected) {
  return { name, actual, expected, ok: typeof actual === 'number' && actual >= expected };
}

function checkEquals(name, actual, expected) {
  return { name, actual, expected, ok: actual === expected };
}

function checkDateAtOrBefore(name, actual, expected) {
  return { name, actual, expected, ok: typeof actual === 'string' && actual <= expected };
}

function checkDateAtOrAfter(name, actual, expected) {
  return { name, actual, expected, ok: typeof actual === 'string' && actual >= expected };
}
