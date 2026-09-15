// Single owner of chat topic state: hydrate → live fetch → cache → render.
// Cache is paint-ahead only. Live /api/labels always wins. Never block on belt.

export const TOPIC_CACHE_KEY = 'rd_topic_nav';
export const TOPIC_CACHE_SCHEMA = 1;
export const LEGACY_TOPIC_CACHE_KEY = 'rd_warm_labels';

const FIXTURE_RE = /(?:^|[^a-z])qa[-_](?:persist|probe|rename|modal)\b/;
const FIXTURE_PHRASE_RE = /\bqa persist\b|\bqa probe\b|\bqa rename\b/;
const JUNK_SLUG_RE = /^(?:qa-(?:persist|probe|rename-modal|rename)-|hist-)|-hier$|^(?:api-define|recap-live|maint-new-topic|tool-parent|tool-child)$/;

export function isFixtureTopicRow(row = {}) {
  const slug = String(row.slug || row.context || row.id || '').trim().toLowerCase();
  if (JUNK_SLUG_RE.test(slug)) return true;
  const blob = [row.slug, row.label, row.name, row.description]
    .map((v) => String(v || '').toLowerCase())
    .join(' ');
  return FIXTURE_RE.test(blob) || FIXTURE_PHRASE_RE.test(blob);
}

export function normalizeTopicPayload(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Array.isArray(raw.labels) || !Array.isArray(raw.groups)) return null;
  const labels = raw.labels
    .filter((row) => !isFixtureTopicRow(row))
    .map(normalizeLabel)
    .filter((row) => row.slug && row.name);
  const groups = raw.groups
    .filter((row) => !isFixtureTopicRow(row))
    .map(normalizeGroup)
    .filter((row) => row.slug && row.name);
  return {
    labels,
    groups,
    inboxCount: Number(raw.inboxCount) || 0,
  };
}

function normalizeLabel(row = {}) {
  const slug = String(row.slug || row.context || '').trim();
  return {
    slug,
    name: String(row.name || row.label || slug).trim(),
    context: String(row.context || slug).trim(),
    description: String(row.description || ''),
    has_context: Boolean(row.has_context),
    icon: row.icon || null,
    sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0,
    parent_slug: row.parent_slug || null,
    visible: row.visible !== false && row.visible !== 0,
  };
}

function normalizeGroup(row = {}) {
  const slug = String(row.slug || '').trim();
  return {
    slug,
    name: String(row.name || row.label || slug).trim(),
    icon: row.icon || 'folder',
    description: row.description || null,
    sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0,
    visible: row.visible !== false && row.visible !== 0,
  };
}

export function topicCacheIsUsable(envelope) {
  if (!envelope || envelope.schema !== TOPIC_CACHE_SCHEMA) return false;
  return Boolean(normalizeTopicPayload(envelope.payload));
}

function readJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function createTopicStore({
  storage,
  fetchImpl,
  setLabels,
  setInboxCount,
  onChange,
} = {}) {
  const store = storage || (typeof localStorage === 'undefined' ? null : localStorage);
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  let epoch = 0;

  function apply(raw) {
    const normalized = normalizeTopicPayload(raw);
    if (!normalized) return null;
    setLabels?.(normalized.labels);
    setInboxCount?.(normalized.inboxCount);
    if (typeof window !== 'undefined') window._topicGroups = normalized.groups;
    onChange?.(normalized);
    return normalized;
  }

  function writeCache(payload) {
    if (!store) return;
    const normalized = normalizeTopicPayload(payload);
    if (!normalized) return;
    try {
      store.setItem(TOPIC_CACHE_KEY, JSON.stringify({
        schema: TOPIC_CACHE_SCHEMA,
        ts: Date.now(),
        payload: normalized,
      }));
    } catch { /* quota */ }
  }

  function readCache() {
    if (!store) return null;
    const fresh = readJson(store, TOPIC_CACHE_KEY);
    if (topicCacheIsUsable(fresh)) return normalizeTopicPayload(fresh.payload);
    const legacy = readJson(store, LEGACY_TOPIC_CACHE_KEY);
    const legacyPayload = legacy?.payload ?? legacy;
    const migrated = normalizeTopicPayload(legacyPayload);
    if (migrated) {
      writeCache(migrated);
      return migrated;
    }
    return null;
  }

  function hydrate() {
    const cached = readCache();
    if (cached) apply(cached);
    return cached;
  }

  async function refresh() {
    const my = ++epoch;
    try {
      const res = await doFetch('/api/labels', { credentials: 'same-origin', cache: 'no-store' });
      if (my !== epoch) return { ok: true, superseded: true };
      if (!res || !res.ok) return { ok: false, status: res?.status || 0 };
      const raw = await res.json();
      if (my !== epoch) return { ok: true, superseded: true };
      const applied = apply(raw);
      if (!applied) return { ok: false, status: res.status, invalid: true };
      writeCache(applied);
      return { ok: true, payload: applied };
    } catch (err) {
      if (my !== epoch) return { ok: true, superseded: true };
      return { ok: false, error: err };
    }
  }

  function bindLiveRefresh() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const kick = () => { refresh().catch(() => {}); };
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') kick();
    });
    window.addEventListener('focus', kick);
  }

  return { hydrate, refresh, bindLiveRefresh, readCache, apply, writeCache };
}

let _store = null;

export function initTopicStore(deps) {
  _store = createTopicStore(deps);
  return _store;
}

export function getTopicStore() {
  return _store;
}
