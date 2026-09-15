import { readKeychainSecret } from './keychain.js';
import { localEmbeddingModelStatus } from './rag.js';

/**
 * First-run readiness contract.
 *
 * Ready is a server predicate, not a screen state:
 *   1. This Mac's display name is confirmed.
 *   2. At least one executable model path is available.
 *   3. Context is present, importing, or the user explicitly chose to chat
 *      without context for now.
 *   4. Background ingest state is reported separately; it never upgrades
 *      queued/failed work to "complete".
 */

const MODEL_KEYCHAIN = Object.freeze([
  'robotdojo-ANTHROPIC_API_KEY',
  'robotdojo-OPENAI_API_KEY',
  'robotdojo-GOOGLE_API_KEY',
  'robotdojo-GOOGLE_AI_API_KEY',
]);

const READY_IMPORT_STATES = new Set(['processed', 'ready', 'done', 'complete']);
const ACTIVE_IMPORT_STATES = new Set(['upload_pending', 'pending', 'queued', 'running', 'importing']);
const FAILED_IMPORT_STATES = new Set(['failed', 'error', 'needs_user']);

function safeGet(db, sql, ...params) {
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function safeAll(db, sql, ...params) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function setting(db, key) {
  const row = safeGet(db, 'SELECT value FROM user_settings WHERE key = ?', key);
  return row?.value || null;
}

function defaultKeychainHas(service) {
  if (process.env.NODE_ENV === 'test') {
    const env = service.replace(/^robotdojo-/, '').replace(/-/g, '_');
    return !!process.env[env];
  }
  try {
    return Boolean(readKeychainSecret(service, { timeout: 1000 }));
  } catch {
    return false;
  }
}

function hasConnectedContext(db) {
  const account = safeGet(
    db,
    "SELECT id FROM accounts WHERE status IN ('active', 'connected') AND vendor IN ('google','microsoft','apple','granola','notion','asana','oura') LIMIT 1",
  );
  if (account) return true;

  const importRow = safeGet(
    db,
    `SELECT status FROM drop_folder_files
     WHERE status IN (${[...READY_IMPORT_STATES].map(() => '?').join(',')})
     LIMIT 1`,
    ...READY_IMPORT_STATES,
  );
  if (importRow) return true;

  const snapshot = safeGet(
    db,
    `SELECT status FROM imports_snapshot
     WHERE status IN (${[...READY_IMPORT_STATES].map(() => '?').join(',')})
     LIMIT 1`,
    ...READY_IMPORT_STATES,
  );
  return !!snapshot;
}

function backgroundIngest(db) {
  const rows = [
    ...safeAll(db, 'SELECT status FROM drop_folder_files'),
    ...safeAll(db, 'SELECT status FROM imports_snapshot'),
    ...safeAll(db, 'SELECT status FROM integration_health'),
  ].map((r) => String(r.status || '').toLowerCase()).filter(Boolean);

  const failed = rows.filter((s) => FAILED_IMPORT_STATES.has(s)).length;
  const active = rows.filter((s) => ACTIVE_IMPORT_STATES.has(s)).length;
  const ready = rows.filter((s) => READY_IMPORT_STATES.has(s) || s === 'ok').length;

  return {
    state: failed > 0 ? 'failed' : active > 0 ? 'running' : ready > 0 ? 'done' : 'idle',
    active,
    failed,
    ready,
  };
}

export function computeSetupReadiness({
  db,
  keychainHas = defaultKeychainHas,
  ollamaReachable = () => false,
  embeddingModelStatus = localEmbeddingModelStatus,
} = {}) {
  if (!db) throw new Error('db_required');

  const blockers = [];
  const deviceConfirmed = setting(db, 'device_name_confirmed') === '1';
  if (!deviceConfirmed) blockers.push('device_name_unconfirmed');

  const configuredModel = MODEL_KEYCHAIN.some((service) => {
    try { return !!keychainHas(service); } catch { return false; }
  }) || ['anthropic', 'openai', 'google', 'gateway', 'ollama'].includes(setting(db, 'llm_provider'));
  const localModel = !!ollamaReachable();
  const modelReady = configuredModel || localModel;
  if (!modelReady) blockers.push('model_path_missing');

  const contextChoice = setting(db, 'setup.context_choice');
  const contextReady = hasConnectedContext(db);
  const contextExplicitlySkipped = contextChoice === 'without_context';
  if (!contextReady && !contextExplicitlySkipped) blockers.push('context_source_missing');

  const ingest = backgroundIngest(db);
  const embedding = embeddingModelStatus();

  return {
    ready_to_chat: blockers.length === 0,
    fully_set_up: blockers.length === 0 && ingest.state !== 'running' && ingest.state !== 'failed',
    device: { confirmed: deviceConfirmed, name: setting(db, 'device_display_name') || 'This Mac' },
    model: { ready: modelReady, configured: configuredModel, local: localModel },
    embedding_model: {
      ...embedding,
      label: 'local embedding model',
      action: embedding.installed ? 'ready' : 'download or retry prewarm',
    },
    context: { ready: contextReady, explicitly_skipped: contextExplicitlySkipped },
    background_ingest: ingest,
    blockers,
  };
}

export default computeSetupReadiness;
