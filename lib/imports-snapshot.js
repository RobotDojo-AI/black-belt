/**
 * lib/imports-snapshot.js
 * Computes import stats snapshot from live tables.
 * Called from the imports_snapshot passive job every sync cycle
 * (lib/passive-sync-orchestrator.js; the overnight IMPORTS phase that
 * duplicated it was retired by st_fd14cdd4).
 * Reading from snapshot instead of live queries makes the imports UI
 * load in <100ms instead of 2-5s on large datasets.
 */
import db from './db.js';

export function computeImportsSnapshot() {
  // Clear stale snapshot
  db.prepare('DELETE FROM imports_snapshot').run();

  const rows = [];

  // 1. Email accounts
  const emailAccounts = db.prepare(`
    WITH email_account_links AS (
      SELECT account_id, id AS email_id, received_at
      FROM emails
      WHERE account_id IS NOT NULL
        AND account_id != ''
      UNION ALL
      SELECT s.account_id, e.id AS email_id, e.received_at
      FROM email_import_sources s
      JOIN emails e ON e.id = s.email_id
      WHERE s.account_id IS NOT NULL
        AND s.account_id != ''
      UNION ALL
      SELECT a.id AS account_id, e.id AS email_id, e.received_at
      FROM accounts a
      JOIN emails e ON a.vendor != 'imports'
        AND e.sender_email = a.email
      WHERE a.type = 'email'
    )
    SELECT a.id, a.email, a.vendor, a.display_name,
           COUNT(DISTINCT l.email_id) as cnt,
           MIN(l.received_at) as earliest,
           MAX(l.received_at) as latest
    FROM accounts a
    LEFT JOIN email_account_links l ON l.account_id = a.id
    WHERE a.type = 'email'
    GROUP BY a.id
  `).all();
  for (const row of emailAccounts) {
    rows.push({
      account_id: row.id,
      account_key: row.email,
      vendor: row.vendor,
      import_type: 'email',
      source_label: row.vendor === 'google'
        ? 'Gmail'
        : row.vendor === 'microsoft'
          ? 'Outlook Mail'
          : (row.display_name || 'Imported Email'),
      item_count: row.cnt,
      earliest_at: row.earliest,
      latest_at: row.latest,
    });
  }

  // 2. Calendar accounts
  const calAccounts = db.prepare(`
    SELECT a.id, a.email, a.vendor,
           COUNT(c.id) as cnt,
           MIN(c.start_time) as earliest,
           MAX(c.start_time) as latest
    FROM accounts a
    LEFT JOIN calendar_events c ON c.account_id = a.id
    WHERE a.type = 'calendar'
    GROUP BY a.id
  `).all();
  for (const row of calAccounts) {
    rows.push({
      account_id: row.id,
      account_key: row.email,
      vendor: row.vendor,
      import_type: 'calendar',
      source_label: row.vendor === 'google' ? 'Google Calendar' : 'Outlook Calendar',
      item_count: row.cnt,
      earliest_at: row.earliest,
      latest_at: row.latest,
    });
  }

  // 3. LLM imports (conversations tagged with import-* tags)
  // tags column is a JSON array; use json_each to extract individual tag values.
  const llmImports = db.prepare(`
    SELECT je.value as tag,
           COUNT(*) as cnt,
           MIN(c.created_at) as earliest,
           MAX(c.created_at) as latest
    FROM conversations c, json_each(c.tags) je
    WHERE je.value LIKE 'import-%'
      AND c.deleted_at IS NULL
    GROUP BY je.value
  `).all();
  for (const row of llmImports) {
    const labelRaw = row.tag.replace('import-', '').replace(/-/g, ' ');
    rows.push({
      account_id: null,
      account_key: null,
      vendor: 'llm',
      import_type: 'llm',
      source_label: labelRaw.charAt(0).toUpperCase() + labelRaw.slice(1),
      item_count: row.cnt,
      earliest_at: row.earliest,
      latest_at: row.latest,
    });
  }

  // 4. RAG sources (chunks by source_type, exclude standard types)
  const ragSources = db.prepare(`
    SELECT source_type,
           COUNT(*) as cnt,
           MIN(created_at) as earliest,
           MAX(created_at) as latest
    FROM chunks
    WHERE source_type NOT IN ('email', 'calendar', 'drive', 'conversation')
    GROUP BY source_type
  `).all();
  for (const row of ragSources) {
    rows.push({
      account_id: null,
      account_key: null,
      vendor: row.source_type,
      import_type: 'rag_source',
      source_label: row.source_type.charAt(0).toUpperCase() + row.source_type.slice(1),
      item_count: row.cnt,
      earliest_at: row.earliest,
      latest_at: row.latest,
    });
  }

  // Bulk insert
  const insert = db.prepare(`
    INSERT INTO imports_snapshot
      (account_id, account_key, vendor, import_type, source_label, item_count, earliest_at, latest_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction((rows) => {
    for (const r of rows) {
      insert.run(r.account_id, r.account_key, r.vendor, r.import_type, r.source_label, r.item_count, r.earliest_at, r.latest_at);
    }
  });
  insertAll(rows);

  return { rows: rows.length };
}
