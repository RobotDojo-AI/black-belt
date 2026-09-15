/**
 * Mailbox topic on an integrations account.
 * Domain inference seeds it; the Integrations picker writes it.
 */
import { PERSONAL_TOPIC } from './topic-routing-policy.js';
import { loadSourceTopicRoutingConfig, topicForSourceAccount } from './topic-source-routing.js';

function hasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
  } catch {
    return false;
  }
}

export function listMailboxAccounts(db) {
  if (!db?.prepare) return [];
  const hasTopic = hasColumn(db, 'accounts', 'topic_slug');
  const rows = db.prepare(`
    SELECT id, vendor, email, display_name${hasTopic ? ', topic_slug' : ''}
      FROM accounts
     WHERE email IS NOT NULL
       AND email LIKE '%@%'
       AND COALESCE(status, 'active') != 'deleted'
     ORDER BY email, vendor, id
  `).all();
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const email = String(row.email || '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push({
      id: row.id,
      vendor: row.vendor,
      email: row.email,
      display_name: row.display_name || row.email,
      topic_slug: hasTopic ? (row.topic_slug || '') : '',
    });
  }
  return out;
}

export function inferredTopicForAccountEmail(email, config = loadSourceTopicRoutingConfig()) {
  return topicForSourceAccount({ accountEmail: email }, config) || '';
}

export function seedAccountTopicsFromDomains(db, { overwrite = false } = {}) {
  if (!hasColumn(db, 'accounts', 'topic_slug')) return { updated: 0 };
  const rows = listMailboxAccounts(db);
  const upd = db.prepare(`
    UPDATE accounts
       SET topic_slug = ?, updated_at = datetime('now')
     WHERE lower(email) = lower(?)
  `);
  let updated = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (row.topic_slug && !overwrite) continue;
      const slug = inferredTopicForAccountEmail(row.email);
      if (!slug) continue;
      updated += upd.run(slug, row.email).changes;
    }
  });
  tx();
  return { updated };
}

export function setAccountTopic(db, accountId, topicSlug) {
  if (!hasColumn(db, 'accounts', 'topic_slug')) {
    throw new Error('accounts.topic_slug missing');
  }
  const row = db.prepare('SELECT id, email FROM accounts WHERE id = ?').get(accountId);
  if (!row) return { ok: false, reason: 'not_found' };
  const slug = String(topicSlug || '').trim();
  if (slug) {
    const topic = db.prepare('SELECT slug FROM user_topics WHERE slug = ?').get(slug);
    if (!topic) return { ok: false, reason: 'unknown_topic' };
  }
  const value = slug || null;
  if (row.email && String(row.email).includes('@')) {
    db.prepare(`
      UPDATE accounts
         SET topic_slug = ?, updated_at = datetime('now')
       WHERE lower(email) = lower(?)
    `).run(value, row.email);
  } else {
    db.prepare(`
      UPDATE accounts
         SET topic_slug = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(value, accountId);
  }
  return { ok: true, id: accountId, email: row.email, topic_slug: value || '' };
}

export function revealMappedWorkTopics(db) {
  const config = loadSourceTopicRoutingConfig();
  const slugs = [...new Set(Object.values(config.domains || {}).filter((s) => s && s !== PERSONAL_TOPIC))];
  if (!slugs.length) return { revealed: 0 };
  const stmt = db.prepare(`
    UPDATE user_topics
       SET visible = 1, updated_at = datetime('now')
     WHERE slug = ?
       AND COALESCE(visible, 0) = 0
  `);
  let revealed = 0;
  const tx = db.transaction(() => {
    for (const slug of slugs) revealed += stmt.run(slug).changes;
  });
  tx();
  return { revealed };
}
