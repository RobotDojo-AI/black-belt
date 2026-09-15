import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './robotdojo-paths.js';

const WEBSITE_SUBFLOWS = Object.freeze([
  { id: 'home', name: 'Home', path: '/' },
  { id: 'login', name: 'Login', path: '/login' },
  { id: 'faq', name: 'FAQ', path: '/#faq', aliases: ['/faq'] },
  { id: 'ask', name: 'Ask', path: '/ask' },
  { id: 'legal', name: 'Legal', paths: ['/privacy', '/terms', '/licensing'] },
  { id: 'install', name: 'Install', paths: ['/install-success', '/install.sh'] },
  { id: 'guidance', name: 'Guidance', paths: ['/auth-google-guidance', '/llms.txt', '/sitemap.xml'] },
]);

const ACCOUNT_SUBFLOWS = Object.freeze([
  { id: 'how-to', name: 'How To Robot', path: '/account/how-to' },
  { id: 'general', name: 'Admin', path: '/account/general' },
  { id: 'integrations', name: 'Integrations', path: '/account/integrations' },
  { id: 'agents', name: 'Agents', path: '/account/agents' },
  { id: 'skills', name: 'Skills', path: '/account/skills' },
  { id: 'you', name: 'You', path: '/account/you' },
  { id: 'shortcuts', name: 'Shortcuts', path: '/account/shortcuts' },
  { id: 'setup', name: 'Setup', path: '/account/setup', hidden: true },
  { id: 'imports', name: 'Imports', path: '/account/imports', hidden: true },
]);

export const PRODUCT_APP_DEFINITIONS = Object.freeze([
  {
    slug: 'website',
    name: 'Website',
    use_case: 'Public website, login, FAQ, public Ask, legal pages, install guidance',
    icon: 'public',
    path: '/',
    belt: 'demo',
    surface: 'public',
    waffle: false,
    launch: false,
    public: true,
    routes: ['/', '/login', '/ask', '/faq', '/privacy', '/terms', '/licensing', '/install-success', '/auth-google-guidance', '/install.sh', '/llms.txt', '/sitemap.xml'],
    subflows: WEBSITE_SUBFLOWS,
  },
  { slug: 'chat', name: 'Chat', use_case: 'Conversation, assistance, and topic-centered work', icon: 'chat', path: '/chat', belt: 'white', surface: 'product', waffle: true, launch: true, public: false },
  { slug: 'podcast', name: 'Podcast', use_case: 'Turn articles, uploads, and long-form sources into private podcast episodes and series', icon: 'podcasts', path: '/podcast', belt: 'black', surface: 'product', waffle: true, launch: false, public: false, routes: ['/podcast', '/apps/podcast/'] },
  { slug: 'network', name: 'Network', use_case: 'Relationship and entity management', icon: 'hub', path: '/network', belt: 'black', surface: 'product', waffle: true, launch: false, public: false },
  { slug: 'health', name: 'Health', use_case: 'Personal health data review and notes', icon: 'favorite', path: '/health', belt: 'black', surface: 'product', waffle: true, launch: false, public: false },
  { slug: 'fitness', name: 'Fitness', use_case: 'Daily meals, training, and recovery', icon: 'exercise', path: '/fitness', belt: 'black', surface: 'product', waffle: true, launch: false, public: false },
  {
    slug: 'account',
    name: 'Account',
    use_case: 'Account management, setup, integrations, identity, and skills',
    icon: 'settings',
    path: '/account',
    belt: 'black',
    surface: 'system',
    waffle: false,
    launch: false,
    public: false,
    routes: ['/account', '/accounts', ...ACCOUNT_SUBFLOWS.map(flow => flow.path)],
    subflows: ACCOUNT_SUBFLOWS,
  },
]);

const LOCKED_ON_WHITE = new Set(['podcast', 'network', 'health', 'fitness']);

export function founderAppPresent(slug) {
  return existsSync(join(REPO_ROOT, 'apps', slug, 'index.html'));
}

export function founderAppsEnabled(env = process.env) {
  const flag = String(env.ROBOTDOJO_FOUNDER_APPS || '').trim();
  if (flag === '1') return true;
  if (flag === '0') return false;
  return PRODUCT_APP_DEFINITIONS.some(
    (app) => app.waffle && app.launch !== true && founderAppPresent(app.slug),
  );
}

function withLock(app) {
  return { ...app, locked_on_white: LOCKED_ON_WHITE.has(app.slug) };
}

export function listProductApps(options = {}) {
  const includeHidden = options.includeHidden === true;
  return PRODUCT_APP_DEFINITIONS
    .filter(app => includeHidden || app.waffle)
    .map(withLock);
}

export function listWaffleApps(options = {}) {
  const founder = options.founder === true
    || (options.founder !== false && founderAppsEnabled(options.env || process.env));
  return PRODUCT_APP_DEFINITIONS
    .filter(app => app.waffle && (founder || app.launch === true))
    .map(withLock);
}

export function sanitizeAppDescriptor(raw = {}) {
  const routes = Array.isArray(raw.routes) ? raw.routes.map(route => String(route)) : undefined;
  const subflows = Array.isArray(raw.subflows)
    ? raw.subflows.map(flow => ({
        id: String(flow.id || '').trim(),
        name: String(flow.name || flow.id || '').trim(),
        path: flow.path ? String(flow.path).trim() : undefined,
        paths: Array.isArray(flow.paths) ? flow.paths.map(path => String(path)) : undefined,
        aliases: Array.isArray(flow.aliases) ? flow.aliases.map(path => String(path)) : undefined,
        hidden: flow.hidden === true,
      }))
    : undefined;
  return {
    id: String(raw.id || raw.slug || '').trim(),
    slug: String(raw.slug || raw.id || '').trim(),
    name: String(raw.name || raw.title || raw.slug || raw.id || '').trim(),
    use_case: raw.use_case ? String(raw.use_case).trim() : undefined,
    icon: String(raw.icon || 'dashboard').trim(),
    path: String(raw.path || '').trim(),
    belt: String(raw.belt || 'black').trim(),
    surface: String(raw.surface || 'topic').trim(),
    waffle: raw.waffle === true,
    launch: raw.launch === true,
    status: String(raw.status || 'registered').trim(),
    classification: String(raw.classification || raw.status || 'registered').trim(),
    target_type: raw.target_type ? String(raw.target_type) : undefined,
    target_id: raw.target_id ? String(raw.target_id) : undefined,
    routes,
    subflows,
  };
}

/** Hide automated QA fixture workbenches from the product UI. */
export function isProductWorkbenchRow(row = {}) {
  const blob = [
    row.id, row.slug, row.title, row.label, row.topic_label, row.target_id,
    row.topic_parent_slug, row.topic_parent_label,
  ].map((v) => String(v || '').toLowerCase()).join(' ');
  // Test harnesses register qa-persist / qa-probe / qa-rename topics.
  // Friends and owners should never see that pollution in product lists.
  if (/\bqa[-_](?:persist|probe|rename|modal)\b/.test(blob)) return false;
  if (blob.includes('qa persist') || blob.includes('qa probe') || blob.includes('qa rename')) return false;
  if (/\btool[- ]parent\b|\btool[- ]child\b/.test(blob)) return false;
  if (/\bhist-/.test(blob) || /-hier\b/.test(blob)) return false;
  if (/\bapi-define\b|\brecap-live\b|\bmaint-new-topic\b/.test(blob)) return false;
  return true;
}

function isShownTopicFlag(value) {
  return value !== 0 && value !== false && value !== '0';
}

/** Match chat nav: hidden T1 hides itself and its T2 topics. */
export function isVisibleTopicWorkbench(row = {}) {
  if (row.target_type && row.target_type !== 'topic') return true;
  if (!isShownTopicFlag(row.topic_visible) && row.topic_visible != null) return false;
  if (!isShownTopicFlag(row.parent_visible) && row.parent_visible != null) return false;
  return true;
}

export function listWorkbenchAppDescriptors(db, options = {}) {
  if (!db) return [];
  const limit = Number.isFinite(options.limit) ? options.limit : 100;
  // Pull a wider candidate set so filtering QA fixtures still fills the limit.
  const fetchLimit = Math.min(Math.max(limit * 4, 100), 500);
  // st_483361e2: LEFT JOIN user_topics (self-joined for the parent label) so a
  // topic-primary substrate row carries its human topic label + parent label.
  // Entity-primary rows have no topic; callers bucket those under "Entities".
  const rows = db.prepare(`
    SELECT
      w.id,
      w.slug,
      w.title,
      w.status,
      a.target_type,
      a.target_id,
      a.label,
      a.role,
      ut.label       AS topic_label,
      ut.parent_slug AS topic_parent_slug,
      ut.visible     AS topic_visible,
      parent.label   AS topic_parent_label,
      parent.visible AS parent_visible,
      (SELECT COUNT(*) FROM workbench_items i
        WHERE i.workbench_id = w.id
          AND (i.kind = 'research' OR i.path LIKE '%/research/%')) AS research_count,
      (SELECT COUNT(*) FROM workbench_items i
        WHERE i.workbench_id = w.id
          AND (i.kind = 'report' OR i.path LIKE '%/reports/%')) AS report_count,
      (SELECT COUNT(*) FROM workbench_items i
        WHERE i.workbench_id = w.id
          AND i.kind IN ('visualization', 'rendering', 'dataset', 'generated_view')) AS artifact_count
    FROM workbenches w
    LEFT JOIN workbench_attachments a
      ON a.workbench_id = w.id
     AND a.role = 'primary'
    LEFT JOIN user_topics ut
      ON a.target_type = 'topic' AND ut.slug = a.target_id
    LEFT JOIN user_topics parent
      ON parent.slug = ut.parent_slug
    WHERE COALESCE(w.status, 'active') != 'archived'
    ORDER BY COALESCE(w.last_activity_at, w.updated_at) DESC, w.title ASC
    LIMIT ?
  `).all(fetchLimit);

  return rows.filter(isProductWorkbenchRow).filter(isVisibleTopicWorkbench).slice(0, limit).map(row => ({
    ...sanitizeAppDescriptor({
      id: row.id,
      slug: row.slug || row.id,
      name: row.topic_label || row.label || String(row.title || '').replace(/\s+Workbench$/i, '') || row.slug || row.id,
      icon: iconForTarget(row.target_type, row.target_id),
      path: row.topic_parent_slug && row.target_id
        ? `/${row.topic_parent_slug}/${row.target_id}`
        : (row.target_type === 'topic' && row.target_id ? `/${row.target_id}` : '/chat'),
      belt: 'black',
      surface: 'topic',
      status: row.status || 'active',
      classification: 'descriptor',
      target_type: row.target_type || 'topic',
      target_id: row.target_id || '',
    }),
    // Additive fields — the existing waffle consumer of /api/apps ignores them.
    doc_path: row.topic_parent_slug && row.target_id
      ? `/${row.topic_parent_slug}/${row.target_id}`
      : (row.target_type === 'topic' && row.target_id ? `/${row.target_id}` : '/chat'),
    topic_label: row.topic_label || null,
    topic_parent_label: row.topic_parent_label || null,
    topic_visible: row.topic_visible,
    parent_visible: row.parent_visible,
    research_count: Number(row.research_count || 0),
    report_count: Number(row.report_count || 0),
    artifact_count: Number(row.artifact_count || 0),
  }));
}

export function buildAppRegistryPayload(db, options = {}) {
  const founder = options.founder === true
    || (options.founder !== false && founderAppsEnabled(options.env || process.env));
  const product_apps = listProductApps({ includeHidden: true });
  const waffle_apps = listWaffleApps({ founder, env: options.env });
  const workbench_apps = founder ? listWorkbenchAppDescriptors(db, options) : [];
  return {
    generated_at: new Date().toISOString(),
    founder_apps: founder,
    product_apps,
    waffle_apps,
    workbench_apps,
  };
}

function iconForTarget(targetType, targetId = '') {
  if (targetType === 'person') return 'person';
  if (targetType === 'company') return 'business';
  if (targetType === 'place') return 'place';
  const slug = String(targetId || '').toLowerCase();
  if (slug.includes('health')) return 'favorite';
  if (slug.includes('career') || slug.includes('job')) return 'work';
  if (slug.includes('coaching')) return 'self_improvement';
  return 'dashboard';
}
