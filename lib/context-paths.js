import { dirname } from 'node:path';
import crypto from 'node:crypto';
import { USER_CONTEXTS_REL } from './robotdojo-paths.js';

export function topicContextPath(db, slug) {
  const row = db?.prepare?.(`SELECT slug, parent_slug FROM user_topics WHERE slug = ?`)?.get(slug);
  if (row?.parent_slug) return `${USER_CONTEXTS_REL}/topics/${row.parent_slug}/${slug}/context.md`;
  return `${USER_CONTEXTS_REL}/topics/${slug}/context.md`;
}

export function topicContextPathForSlugs(parentSlug, slug) {
  if (parentSlug) return `${USER_CONTEXTS_REL}/topics/${parentSlug}/${slug}/context.md`;
  return `${USER_CONTEXTS_REL}/topics/${slug}/context.md`;
}

export function entityContextPath(type, id, db = null) {
  return `${entityOwnerRoot(type, id, db)}/context.md`;
}

export function entityOwnerRoot(type, id, db = null) {
  return `${USER_CONTEXTS_REL}/${entityDir(type)}/${entityPackageName(type, id, db)}`;
}

export function entityPackageName(type, id, db = null) {
  const displayName = entityDisplayName(type, id, db) || String(id);
  return entityPackageNameFromDisplay(id, displayName);
}

export function entityPackageNameFromDisplay(id, displayName) {
  return `${slugify(displayName)}--${entityShortId(id)}`;
}

export function entityDisplayName(type, id, db = null) {
  if (!db?.prepare || !id) return '';
  if (type === 'person') {
    const row = db.prepare(`SELECT display_name FROM people WHERE id = ?`).get(id);
    return row?.display_name || '';
  }
  if (type === 'company') {
    const row = db.prepare(`SELECT name FROM companies WHERE id = ?`).get(id);
    return row?.name || '';
  }
  if (type === 'place') {
    const row = db.prepare(`SELECT name FROM places WHERE CAST(id AS TEXT) = ?`).get(String(id));
    return row?.name || '';
  }
  return '';
}

export function entityShortId(id) {
  const value = String(id || '');
  const hex = value.replace(/[^0-9a-f]/gi, '');
  if (hex.length >= 16) return hex.slice(0, 16).toLowerCase();
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
}

export function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'entity';
}

export function contextOwnerRoot(contextPath) {
  const value = String(contextPath || '');
  if (value.endsWith('/context.md')) return dirname(value);
  if (value.endsWith('.md')) return value.replace(/\.md$/, '');
  return value;
}

export function entityDir(type) {
  if (type === 'person') return 'people';
  if (type === 'company') return 'companies';
  if (type === 'place') return 'places';
  throw new Error(`unsupported entity context type: ${type}`);
}
