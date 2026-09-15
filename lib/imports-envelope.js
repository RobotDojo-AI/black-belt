/**
 * Stable imports payload for the Account imports view.
 *
 * The snapshot table is intentionally compact, but the browser needs grouped
 * rows. Keeping the grouping pure makes the response shape testable without
 * loading the full app server.
 */

export function buildImportsEnvelope({ snapshotRows = [], dropFolderRows = [], freshness = null } = {}) {
  const accountMap = new Map();
  const llmRows = [];
  const ragSources = [];

  for (const row of snapshotRows) {
    const type = row.import_type;
    if (type === 'email' || type === 'calendar') {
      const key = `${row.vendor || 'unknown'}:${row.account_key || row.account_id || 'local'}`;
      if (!accountMap.has(key)) {
        const isArchive = row.vendor === 'imports';
        accountMap.set(key, {
          account_id: row.account_id || null,
          account_key: row.account_key || null,
          display_name: isArchive
            ? (row.source_label || row.account_key || 'Imported account')
            : (row.account_key || row.source_label || row.vendor || 'Imported account'),
          email: isArchive ? null : (row.account_key || null),
          vendor: row.vendor || null,
          email_count: 0,
          cal_count: 0,
          email_earliest: null,
          email_latest: null,
          cal_earliest: null,
          cal_latest: null,
        });
      }
      const account = accountMap.get(key);
      if (type === 'email') {
        account.email_count += Number(row.item_count) || 0;
        account.email_earliest = earlier(account.email_earliest, row.earliest_at);
        account.email_latest = later(account.email_latest, row.latest_at);
      } else {
        account.cal_count += Number(row.item_count) || 0;
        account.cal_earliest = earlier(account.cal_earliest, row.earliest_at);
        account.cal_latest = later(account.cal_latest, row.latest_at);
      }
      continue;
    }

    if (type === 'llm') {
      llmRows.push({
        name: row.source_label || row.vendor || 'LLM import',
        email: row.account_key || null,
        vendor: row.vendor || 'llm',
        count: Number(row.item_count) || 0,
        earliest: row.earliest_at || null,
        latest: row.latest_at || null,
      });
      continue;
    }

    if (type === 'rag_source') {
      ragSources.push({
        source_type: row.vendor || row.source_label || 'document',
        source_label: row.source_label || row.vendor || 'Document',
        item_count: Number(row.item_count) || 0,
        earliest: row.earliest_at || null,
        latest: row.latest_at || null,
      });
    }
  }

  return {
    accountRows: [...accountMap.values()],
    llmRows,
    ragSources,
    dropFolderRows: dropFolderRows.map(normalizeDropFolderRow),
    freshness: {
      latest: freshness?.latest || null,
      stale: freshness?.latest ? isStale(freshness.latest) : true,
      refresh_needed: freshness?.latest ? isStale(freshness.latest) : true,
      status: freshness?.latest && !isStale(freshness.latest) ? 'ready' : 'queued',
    },
  };
}

function normalizeDropFolderRow(row) {
  return {
    path: row.path,
    original_name: row.original_name || fileName(row.path),
    status: row.status || 'unknown',
    topic_t1: row.topic_t1 || null,
    topic_t2: row.topic_t2 || null,
    doc_type: row.doc_type || null,
    size_bytes: row.size_bytes ?? null,
    processed_at: row.processed_at || null,
    error_message: row.error_message || null,
  };
}

function fileName(path) {
  return String(path || '').split('/').filter(Boolean).pop() || 'Imported file';
}

function earlier(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return b < a ? b : a;
}

function later(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return b > a ? b : a;
}

function isStale(timestamp) {
  const ageMs = Date.now() - new Date(timestamp).getTime();
  return Number.isFinite(ageMs) ? ageMs > 24 * 60 * 60 * 1000 : true;
}
