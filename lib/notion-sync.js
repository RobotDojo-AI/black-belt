/**
 * Notion sync — pushes user_topics context_md to a Notion workspace.
 * Robot Dojo is source of truth; Notion is a read mirror.
 * Token: Keychain key robotdojo-NOTION_TOKEN (integration token).
 * Parent: Keychain key robotdojo-NOTION_PARENT_PAGE_ID.
 */
import { createHash } from 'node:crypto';
import db from './db.js';
import { secret } from './config.js';
import { markdownToBlocks } from './notion-blocks.js';

const NOTION_VERSION = '2022-06-28';

function notionHeaders() {
  const token = secret('NOTION_TOKEN');
  if (!token) throw new Error('NOTION_TOKEN not in Keychain — store via request_credential tool');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Notion-Version': NOTION_VERSION,
  };
}

async function notionFetch(method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: notionHeaders(),
    body: body != null ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Notion ${method} ${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function getOrCreateParentPage() {
  const pageId = secret('NOTION_PARENT_PAGE_ID');
  if (!pageId) {
    const search = await notionFetch('POST', '/search', { filter: { value: 'page', property: 'object' }, page_size: 1 });
    const first = search.results?.[0];
    if (!first) throw new Error('No Notion pages found and NOTION_PARENT_PAGE_ID not set');
    return first.id;
  }
  return pageId;
}

function contentHash(title, content) {
  return createHash('md5').update(`${title}\n${content}`).digest('hex');
}

async function appendBlocks(pageId, blocks) {
  for (let i = 0; i < blocks.length; i += 100) {
    await notionFetch('PATCH', `/blocks/${pageId}/children`, { children: blocks.slice(i, i + 100) });
  }
}

async function clearPageBlocks(pageId) {
  let cursor;
  do {
    const params = cursor ? `?start_cursor=${cursor}` : '';
    const children = await notionFetch('GET', `/blocks/${pageId}/children${params}`);
    for (const child of children.results || []) {
      try { await notionFetch('DELETE', `/blocks/${child.id}`); } catch { /* already gone */ }
    }
    cursor = children.has_more ? children.next_cursor : null;
  } while (cursor);
}

const stmts = {
  getTopics: db.prepare(`SELECT slug, label, context_md, notion_page_id FROM user_topics WHERE context_md IS NOT NULL AND context_md != '' ORDER BY sort_order`),
  getBySlug: db.prepare(`SELECT slug, label, context_md, notion_page_id FROM user_topics WHERE slug = ?`),
  setPageId: db.prepare(`UPDATE user_topics SET notion_page_id = ? WHERE slug = ?`),
};

async function syncTopic(topic, parentPageId) {
  const { slug, label, context_md, notion_page_id } = topic;
  const blocks = markdownToBlocks(context_md);
  const hash = contentHash(label, context_md);

  if (notion_page_id) {
    try {
      await notionFetch('GET', `/pages/${notion_page_id}`);
    } catch {
      stmts.setPageId.run(null, slug);
      return syncTopic({ ...topic, notion_page_id: null }, parentPageId);
    }

    await notionFetch('PATCH', `/pages/${notion_page_id}`, {
      properties: { title: { title: [{ type: 'text', text: { content: label } }] } },
    });
    await clearPageBlocks(notion_page_id);
    if (blocks.length > 0) await appendBlocks(notion_page_id, blocks);
    return { action: 'updated', notionPageId: notion_page_id };
  }

  const page = await notionFetch('POST', '/pages', {
    parent: { type: 'page_id', page_id: parentPageId },
    properties: { title: { title: [{ type: 'text', text: { content: label } }] } },
    children: blocks.slice(0, 100),
  });

  if (blocks.length > 100) await appendBlocks(page.id, blocks.slice(100));
  stmts.setPageId.run(page.id, slug);
  return { action: 'created', notionPageId: page.id };
}

export async function pushTopicsToNotion({ maxTopics = Infinity } = {}) {
  const parentPageId = await getOrCreateParentPage();
  const allTopics = stmts.getTopics.all();
  const topics = allTopics.slice(0, Number.isFinite(maxTopics) ? Math.max(0, maxTopics) : allTopics.length);
  const results = { created: 0, updated: 0, errors: 0, total: allTopics.length, attempted: topics.length, remaining: Math.max(0, allTopics.length - topics.length) };

  for (const topic of topics) {
    try {
      const r = await syncTopic(topic, parentPageId);
      results[r.action]++;
      await new Promise(res => setTimeout(res, 350));
    } catch (e) {
      results.errors++;
      console.error(`[notion-sync] "${topic.slug}" failed:`, e.message);
    }
  }

  console.info(`[notion-sync] done — created=${results.created} updated=${results.updated} errors=${results.errors}`);
  db.prepare(`UPDATE accounts SET synced_at=datetime('now'), last_error=NULL WHERE vendor='notion'`).run();
  return results;
}

export async function pushTopicToNotion(topicSlug) {
  const topic = stmts.getBySlug.get(topicSlug);
  if (!topic) throw new Error(`Topic not found: ${topicSlug}`);
  if (!topic.context_md) throw new Error(`Topic "${topicSlug}" has no context_md`);
  const parentPageId = await getOrCreateParentPage();
  return syncTopic(topic, parentPageId);
}
