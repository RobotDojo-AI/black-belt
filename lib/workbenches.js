import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  REPO_ROOT,
  defaultDistillationContract,
  newestMtime,
  parseResumeIndex,
  scanWorkbenchRoot,
  stableId,
  toRepoPath,
  writeResumeIndex,
} from './workbench-files.js';
import {
  contextOwnerRoot,
  entityContextPath,
  entityDir,
  entityOwnerRoot,
  topicContextPath as packageTopicContextPath,
} from './context-paths.js';
import { USER_CONTEXTS_REL, USER_WORKBENCHES_REL } from './robotdojo-paths.js';
import { createTopic, isJunkTopicSlug } from './topics.js';
import { isScaffoldProjection, projectionFromLog } from './workbench-log.js';

export const SUPPORTED_ATTACHMENT_TYPES = new Set(['topic', 'person', 'company', 'place']);
export const UNSUPPORTED_ATTACHMENT_TYPES = new Set(['thing', 'health_condition']);

const REQUIRED_RESUME_FIELDS = [
  'workbench_id',
  'title',
  'status',
  'root',
  'attachments',
  'current_question',
  'latest_state',
  'next_action',
  'distillation_contract',
  'open_decisions',
  'unresolved_questions',
  'related_entities',
  'canonical_promotion_targets',
  'indexed_substrate',
  'minimum_boot',
  'deep_links',
  'last_activity_at',
  'last_promotion_at',
];

const KNOWN_COMPANY_TARGETS = new Map([
  ['airbnb', { id: 'airbnb', label: 'Airbnb' }],
  ['air-bnb', { id: 'airbnb', label: 'Airbnb' }],
  ['nar', { id: 'national-association-of-realtors', label: 'National Association of Realtors' }],
  ['national-association-of-realtors', { id: 'national-association-of-realtors', label: 'National Association of Realtors' }],
  ['national-association-of-realtors-nar', { id: 'national-association-of-realtors', label: 'National Association of Realtors' }],
]);

export function validateAttachment(attachment) {
  const targetType = attachment.target_type || attachment.type;
  const targetId = attachment.target_id || attachment.id;
  if (UNSUPPORTED_ATTACHMENT_TYPES.has(targetType)) {
    throw new Error(`unsupported workbench attachment type: ${targetType}`);
  }
  if (!SUPPORTED_ATTACHMENT_TYPES.has(targetType)) {
    throw new Error(`workbench attachment target_type must be topic, person, company, or place`);
  }
  if (!targetId) throw new Error('workbench attachment target_id required');
  if (targetType === 'topic' && targetId === 'health_condition') {
    throw new Error('health workbenches attach to topic:health, not health_condition');
  }
  return { target_type: targetType, target_id: String(targetId), role: attachment.role || 'primary' };
}

// Canonical aliases for owner-mode fixture lookup. Generic tokens only —
// hardcoding the alias map in logic is intentional (it is not PII). The
// PII-bearing data (topic ids, file paths, prose) lives in the gitignored
// `user/workbenches/owner-fixtures.json` and never enters committed code.
const OWNER_FIXTURE_ALIASES = new Map([
  ['robot-dojo', 'robot dojo'],
  ['robotdojo', 'robot dojo'],
]);

const OWNER_FIXTURES_RELATIVE = `${USER_WORKBENCHES_REL}/owner-fixtures.json`;

// Memoize the JSON read per repoRoot to avoid re-parsing on every call inside a
// boot reconcile loop. Owner-fixtures.json is owner-edited rarely; staleness
// across a single process lifetime is acceptable and is exactly the contract
// the existing fixture path had (the data was static module-level constants).
const OWNER_FIXTURE_CACHE = new Map();

function loadOwnerFixtures(repoRoot) {
  if (OWNER_FIXTURE_CACHE.has(repoRoot)) return OWNER_FIXTURE_CACHE.get(repoRoot);
  const path = resolve(repoRoot, OWNER_FIXTURES_RELATIVE);
  let fixtures = null;
  try {
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fixtures = parsed;
    }
  } catch {
    // WHY: malformed/unreadable owner-fixtures.json is graceful-null, not
    // throw. A bad local data file should never block customer installs (who
    // never hit this path because owner-mode is off) nor crash the owner's
    // workbench-open path — they get the "no registered workbench found"
    // recovery surface instead.
    fixtures = null;
  }
  OWNER_FIXTURE_CACHE.set(repoRoot, fixtures);
  return fixtures;
}

export function fixtureForTarget(target, options = {}) {
  // Customer installs start bare. Historical owner fixtures are available
  // only in explicit owner mode for local migration/recovery of pre-launch
  // workbenches; normal workbench creation resolves from the user's topics and
  // entities instead of hard-coded fixtures.
  if (process.env.ROBOTDOJO_OWNER_MODE !== '1') return null;

  const normalized = String(target || '').trim().toLowerCase();
  if (!normalized) return null;
  const canonical = OWNER_FIXTURE_ALIASES.get(normalized) || normalized;

  const repoRoot = options.repoRoot || REPO_ROOT;
  const fixtures = loadOwnerFixtures(repoRoot);
  if (!fixtures) return null;
  const preset = fixtures[canonical];
  return preset || null;
}

// (Owner fixture presets used to live as hardcoded literals here. They were
// relocated to the gitignored user/workbenches/owner-fixtures.json on st_f0196b64
// because the slugs and transcript path slugs are PII by definition. The
// committed code now carries only logic: the owner-mode gate, the alias map,
// and the graceful-degradation read above.)


export function registerWorkbench(db, args, options = {}) {
  const fixture = args.target ? fixtureForTarget(args.target, { repoRoot: options.repoRoot }) : null;
  const resolved = !fixture && args.target && db ? resolvedDefaultWorkbenchSpec(db, args.target) : null;
  const spec = { ...(fixture || resolved || {}), ...definedOnly(args || {}) };
  if (args.id && !args.slug) spec.slug = args.id;
  if (!spec.id) throw new Error('workbench id required');
  if (!spec.slug) spec.slug = spec.id;
  if (!spec.title) spec.title = spec.slug;
  if (!spec.root_path) throw new Error('workbench root_path required');
  const attachments = normalizeAttachments(spec);
  attachments.forEach(validateAttachment);
  if (args.id && fixture && !args.root_path && !args.rootPath) {
    const primary = attachments.find(a => (a.role || 'primary') === 'primary') || attachments[0];
    if (primary.target_type === 'topic') spec.root_path = topicWorkbenchRoot(db, primary.target_id, args.id);
    else spec.root_path = entityWorkbenchRoot(primary.target_type, primary.target_id, db, args.id);
    spec.resume_path = `${spec.root_path}/INDEX.md`;
  }

  const repoRoot = options.repoRoot || REPO_ROOT;
  if (!options.dryRun) ensureFixtureEntities(db, attachments);
  const defaultResumePath = defaultWorkbenchResumePath(db, spec, attachments);
  const resumePath = (args.id && !args.resume_path)
    ? defaultResumePath
    : (spec.resume_path || defaultResumePath);
  if (!spec.root_path.startsWith(`${USER_WORKBENCHES_REL}/`) && !args.resume_path) {
    spec.root_path = dirname(resumePath);
  }
  const rootExists = existsSync(resolve(repoRoot, spec.root_path));
  const rootForScan = rootExists ? spec.root_path : dirname(resumePath);
  const items = options.items || collectItemsForSpec(spec, rootForScan, { repoRoot, maxFiles: options.maxFiles });
  const lastActivity = newestMtime(items.map(item => item.path), repoRoot) || new Date().toISOString();

  if (options.dryRun) {
    return {
      dry_run: true,
      workbench: spec,
      attachments,
      items,
      resume_path: resumePath,
      root_exists: rootExists,
    };
  }

  ensureResumePointer(resumePath, spec, attachments, items, {
    repoRoot,
    preserveExistingIndex: options.preserveExistingIndex,
  });
  for (const attachment of attachments) {
    appendPointerForAttachment(db, attachment, resumePath, { repoRoot });
  }

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO workbenches
        (id, slug, title, status, root_path, summary, current_question, latest_state, next_action, resume_path, metadata, last_activity_at, updated_at)
      VALUES
        (@id, @slug, @title, @status, @root_path, @summary, @current_question, @latest_state, @next_action, @resume_path, @metadata, @last_activity_at, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        slug=excluded.slug,
        title=excluded.title,
        status=excluded.status,
        root_path=excluded.root_path,
        summary=excluded.summary,
        current_question=excluded.current_question,
        latest_state=excluded.latest_state,
        next_action=excluded.next_action,
        resume_path=excluded.resume_path,
        metadata=excluded.metadata,
        last_activity_at=excluded.last_activity_at,
        updated_at=datetime('now')
    `).run({
      id: spec.id,
      slug: spec.slug,
      title: spec.title,
      status: spec.status || 'active',
      root_path: spec.root_path,
      summary: spec.summary || '',
      current_question: spec.current_question || '',
      latest_state: spec.latest_state || '',
      next_action: spec.next_action || '',
      resume_path: resumePath,
      metadata: JSON.stringify(spec.metadata || {}),
      last_activity_at: lastActivity,
    });

    const insertAttachment = db.prepare(`
      INSERT INTO workbench_attachments
        (workbench_id, target_type, target_id, role, label, metadata)
      VALUES
        (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workbench_id, target_type, target_id, role) DO UPDATE SET
        label=excluded.label,
        metadata=excluded.metadata
    `);
    for (const attachment of attachments) {
      insertAttachment.run(
        spec.id,
        attachment.target_type,
        attachment.target_id,
        attachment.role || 'primary',
        attachment.label || '',
        JSON.stringify(attachment.metadata || {})
      );
    }

    upsertWorkbenchItems(db, spec.id, items);
  });
  tx();

  return getWorkbench(db, spec.id);
}

function definedOnly(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined && v !== null));
}

function normalizeAttachments(spec) {
  const attachments = [];
  if (spec.attachment) attachments.push(spec.attachment);
  if (spec.attach) attachments.push(...[].concat(spec.attach));
  if (spec.attachments) attachments.push(...spec.attachments);
  if (spec.secondary) attachments.push(...spec.secondary);
  return attachments.length ? attachments : [{ target_type: 'topic', target_id: spec.slug, role: 'primary' }];
}

function ensureFixtureEntities(db, attachments) {
  for (const attachment of attachments) {
    if (attachment.target_type === 'topic') {
      const parentSlug = attachment.parent_slug || attachment.metadata?.parent_slug || '';
      if (parentSlug) ensureParentTopic(db, parentSlug);
      const existing = db.prepare(`SELECT slug, parent_slug FROM user_topics WHERE slug = ?`).get(attachment.target_id);
      if (existing) {
        // user_topics is the source of truth after the owner edits in Chat.
        // Disk folders discover new workbenches; they must not move, rename,
        // or un-hide a topic the owner already placed.
      } else {
        createTopic(db, {
          slug: attachment.target_id,
          label: attachment.label || titleFromSlug(attachment.target_id),
          parent_slug: parentSlug || null,
          visible: 1,
        });
      }
    }
    if (attachment.target_type === 'company') {
      db.prepare(`
        INSERT INTO companies (id, name, tier, industry, description, created_at, updated_at)
        VALUES (?, ?, 'important', '', ?, datetime('now'), datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          name=COALESCE(NULLIF(companies.name, ''), excluded.name),
          description=CASE WHEN companies.description = '' THEN excluded.description ELSE companies.description END,
          updated_at=datetime('now')
      `).run(
        attachment.target_id,
        attachment.label || titleFromSlug(attachment.target_id),
        `Canonical company entity for ${attachment.label || titleFromSlug(attachment.target_id)} workbench substrate.`
      );
    }
  }
}

function ensureParentTopic(db, parentSlug) {
  const existing = db.prepare(`SELECT slug FROM user_topics WHERE slug = ?`).get(parentSlug);
  if (existing) return;
  createTopic(db, {
    slug: parentSlug,
    label: titleFromSlug(parentSlug),
    visible: 1,
  });
}

function ensureResumePointer(resumePath, spec, attachments, items, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  // WHY preserveExistingIndex: the disk-scan registration path (used by the
  // boot reconcile) treats a user-curated INDEX.md as authoritative.
  // writeResumeIndex collapses multi-paragraph "Latest State" prose to its
  // first line via parseResumeIndex round-tripping, which silently destroys
  // hand-authored workbench memory. When this flag is set and the resume
  // file already exists, we leave its content alone and only ensure the
  // companion LOG.md / SYNTHESIS.md scaffolding is present.
  if (options.preserveExistingIndex && existsSync(resolve(repoRoot, resumePath))) {
    ensureWorkbenchMemoryFiles(spec.root_path, spec, { repoRoot });
    return;
  }
  const deepLinks = uniquePaths([spec.root_path, ...items.slice(0, 8).map(item => item.path)]);
  const minimumBoot = uniquePaths([
    resumePath,
    ...items.filter(i => ['status', 'decision_log', 'todo'].includes(i.kind)).slice(0, 4).map(i => i.path),
  ]);
  writeResumeIndex(resumePath, {
    ...spec,
    related_entities: attachments.filter(a => a.target_type !== 'topic').map(a => ({
      type: a.target_type,
      id: a.target_id,
      role: a.role,
    })),
    canonical_promotion_targets: attachments.map(a => ({
      type: a.target_type,
      id: a.target_id,
      role: a.role,
    })),
    distillation_contract: spec.distillation_contract,
    minimum_boot: minimumBoot,
    deep_links: deepLinks,
  }, { repoRoot });
  ensureWorkbenchMemoryFiles(spec.root_path, spec, { repoRoot });
}

export function ensureWorkbenchMemoryFiles(rootPath, spec, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const rootAbs = resolve(repoRoot, rootPath);
  mkdirSync(rootAbs, { recursive: true });
  const logPath = resolve(rootAbs, 'LOG.md');
  const synthesisPath = resolve(rootAbs, 'SYNTHESIS.md');
  if (!existsSync(logPath)) {
    writeFileSync(logPath, [
      `# ${spec.title || spec.id || 'Workbench'} Log`,
      '',
      'Append-only operational memory for sessions, events, decisions captured in the moment, and source additions.',
      '',
    ].join('\n'));
  }
  if (!existsSync(synthesisPath)) {
    writeFileSync(synthesisPath, [
      `# ${spec.title || spec.id || 'Workbench'} Synthesis`,
      '',
      'Deep workbench-level distillation. This can be longer than canonical context and should be compacted over time.',
      '',
    ].join('\n'));
  }
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function collectItemsForSpec(spec, rootForScan, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const seen = new Map();
  const roots = [rootForScan, ...(spec.extra_roots || [])];
  for (const root of roots) {
    const maxFiles = options.maxFiles || (String(root).includes(`${USER_CONTEXTS_REL}/companies`) ? 250 : 1000);
    const items = scanWorkbenchRoot(root, { repoRoot, maxFiles });
    for (const item of items) seen.set(item.path, item);
  }
  return [...seen.values()];
}

export function upsertWorkbenchItems(db, workbenchId, items) {
  const insert = db.prepare(`
    INSERT INTO workbench_items
      (id, workbench_id, kind, path, title, content_hash, status, staleness, metadata, last_seen_at, updated_at)
    VALUES
      (@id, @workbench_id, @kind, @path, @title, @content_hash, @status, @staleness, @metadata, datetime('now'), datetime('now'))
    ON CONFLICT(workbench_id, path) DO UPDATE SET
      kind=excluded.kind,
      title=excluded.title,
      content_hash=excluded.content_hash,
      status=excluded.status,
      staleness=excluded.staleness,
      metadata=excluded.metadata,
      last_seen_at=datetime('now'),
      updated_at=datetime('now')
  `);
  const itemIds = [];
  for (const item of items) {
    const itemId = `wbi_${stableId(workbenchId, item.path)}`;
    itemIds.push(itemId);
    insert.run({
      id: itemId,
      workbench_id: workbenchId,
      kind: item.kind,
      path: item.path,
      title: item.title || basename(item.path),
      content_hash: item.content_hash,
      status: item.status || 'current',
      staleness: item.staleness || 'current',
      metadata: JSON.stringify(item.metadata || {}),
    });
  }
  if (itemIds.length) {
    const placeholders = itemIds.map(() => '?').join(',');
    db.prepare(`DELETE FROM workbench_items WHERE workbench_id = ? AND id NOT IN (${placeholders})`).run(workbenchId, ...itemIds);
  }
  return { workbench_id: workbenchId, items: items.length };
}

export function getWorkbench(db, idOrSlug) {
  const wb = db.prepare(`
    SELECT * FROM workbenches WHERE id = ? OR slug = ?
  `).get(idOrSlug, idOrSlug);
  if (!wb) return null;
  const attachments = db.prepare(`
    SELECT target_type, target_id, role, label, metadata
    FROM workbench_attachments
    WHERE workbench_id = ?
    ORDER BY CASE role WHEN 'primary' THEN 0 WHEN 'secondary' THEN 1 WHEN 'related' THEN 2 ELSE 3 END, target_type, target_id
  `).all(wb.id).map(row => ({ ...row, metadata: parseJson(row.metadata) }));
  const items = db.prepare(`
    SELECT * FROM workbench_items WHERE workbench_id = ? ORDER BY kind, path
  `).all(wb.id).map(row => ({ ...row, metadata: parseJson(row.metadata) }));
  return { ...wb, metadata: parseJson(wb.metadata), attachments, items };
}

export function primaryWorkbenchForTarget(db, targetType, targetId) {
  const type = String(targetType || '').trim();
  const id = String(targetId || '').trim();
  if (!type || !id || !db?.prepare) return null;
  try {
    return db.prepare(`
      SELECT w.id, w.root_path, w.latest_state, w.next_action
        FROM workbenches w
        JOIN workbench_attachments a ON a.workbench_id = w.id
       WHERE a.target_type = ?
         AND a.target_id = ?
         AND COALESCE(a.role, 'primary') = 'primary'
         AND w.status != 'archived'
       ORDER BY COALESCE(w.last_activity_at, w.updated_at) DESC
       LIMIT 1
    `).get(type, id) || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a human URL key to a workbench without creating one.
 * Accepts id (`wk_health`), slug (`health-workbench`), or primary topic (`health`).
 */
export function lookupWorkbenchRoute(db, key) {
  const raw = String(key || '').trim();
  if (!raw || !db?.prepare) return null;
  try {
    const direct = getWorkbench(db, raw) || getWorkbench(db, `${raw}-workbench`);
    if (direct) return direct;
    const row = db.prepare(`
      SELECT w.id
        FROM workbenches w
        JOIN workbench_attachments a ON a.workbench_id = w.id
       WHERE a.target_type = 'topic'
         AND a.role = 'primary'
         AND lower(a.target_id) = lower(?)
       ORDER BY COALESCE(w.last_activity_at, w.updated_at) DESC
       LIMIT 1
    `).get(raw);
    return row ? getWorkbench(db, row.id) : null;
  } catch {
    return null;
  }
}

/**
 * Browser URL for a workbench is the topic path only: /t1 or /t1/t2.
 * Slash command /work stays agent-only. /workbench is the Research index.
 */
export function topicUrlFromWorkbenchRoot(rootPath) {
  const root = String(rootPath || '').replace(/\\/g, '/');
  const nested = root.match(/\/topics\/([^/]+)\/([^/]+)\//);
  if (nested && !/^wk[_-]/i.test(nested[2])) return `/${nested[1]}/${nested[2]}`;
  const top = root.match(/\/topics\/([^/]+)\//);
  if (top && !/^wk[_-]/i.test(top[1])) return `/${top[1]}`;
  return '';
}

export function workbenchPublicUrl(workbench) {
  const fromRoot = topicUrlFromWorkbenchRoot(workbench?.root_path);
  if (fromRoot) return fromRoot;
  const primary = (workbench?.attachments || []).find((a) => a.role === 'primary' && a.target_type === 'topic');
  if (primary?.target_id) {
    const parent = workbench?.topic_parent_slug || primary.parent_slug;
    return parent ? `/${parent}/${primary.target_id}` : `/${primary.target_id}`;
  }
  return '/workbench';
}

export function resolveTarget(db, target) {
  const { raw, matches } = resolveCandidateTargets(db, target);
  const duplicateType = duplicateEntityType(matches);
  if (duplicateType) throw new Error(`ambiguous entity target: ${raw}`);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`ambiguous target: ${raw}`);
  throw new Error(`no topic or supported entity matched: ${raw}`);
}

function lookupTypedEntity(db, targetType, targetId) {
  const type = String(targetType || '').toLowerCase();
  const id = String(targetId || '').trim();
  if (!id) return null;
  if (type === 'person') {
    const row = db.prepare(`SELECT id, display_name AS label FROM people WHERE id = ? LIMIT 1`).get(id);
    return row ? { target_type: 'person', target_id: row.id, label: row.label } : null;
  }
  if (type === 'company') {
    const row = db.prepare(`SELECT id, name AS label FROM companies WHERE id = ? LIMIT 1`).get(id);
    return row ? { target_type: 'company', target_id: row.id, label: row.label } : null;
  }
  if (type === 'place') {
    const row = db.prepare(`
      SELECT CAST(id AS TEXT) AS target_id, name AS label
      FROM places
      WHERE CAST(id AS TEXT) = ?
      LIMIT 1
    `).get(id);
    return row ? { target_type: 'place', target_id: row.target_id, label: row.label } : null;
  }
  return null;
}

export function resolveCandidateTargets(db, target) {
  const raw = String(target || '').replace(/^workbench\s+/i, '').trim();
  if (!raw) throw new Error('target required');
  const typed = raw.match(/^(person|company|place):(.+)$/i);
  if (typed) {
    const match = lookupTypedEntity(db, typed[1], typed[2]);
    return { raw, matches: match ? [match] : [] };
  }
  const lower = raw.toLowerCase();
  const slug = slugify(lower);
  const matches = [];
  const knownCompany = KNOWN_COMPANY_TARGETS.get(slug);
  if (knownCompany) {
    matches.push({ target_type: 'company', target_id: knownCompany.id, label: knownCompany.label });
  }
  // Topic candidates are exact slug/label matches; entity candidates below
  // are LIKE-fuzzy and intentionally broader to seed entity workbench creation.
  const topicMatches = db.prepare(`
    SELECT 'topic' AS target_type, slug AS target_id, label
    FROM user_topics
    WHERE lower(slug) = ? OR lower(label) = ?
    LIMIT 5
  `).all(slug, lower);
  matches.push(...topicMatches);
  matches.push(...db.prepare(`
    SELECT 'person' AS target_type, id AS target_id, display_name AS label
    FROM people WHERE lower(display_name) LIKE ? LIMIT 5
  `).all(`%${lower}%`));
  matches.push(...db.prepare(`
    SELECT 'company' AS target_type, id AS target_id, name AS label
    FROM companies WHERE lower(name) LIKE ? OR lower(id) = ? LIMIT 5
  `).all(`%${lower}%`, slug));
  matches.push(...db.prepare(`
    SELECT 'place' AS target_type, CAST(id AS TEXT) AS target_id, name AS label
    FROM places WHERE lower(name) LIKE ? LIMIT 5
  `).all(`%${lower}%`));

  const seen = new Set();
  const deduped = matches.filter(match => {
    const key = `${match.target_type}:${match.target_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // WHY: a topic slug that exactly equals the user's input is the highest-
  // precision signal we have. When such a topic exists, any same-typed entity
  // matches (multiple "*health*" people/companies) are fuzzy LIKE noise — they
  // would otherwise trip duplicateEntityType ambiguity and prevent the topic
  // from ever resolving (root cause: st_f0196b64 health workbench unopenable
  // because "health" topic collided with "United Healthcare"/"Seedhealth"/...).
  // Restrict candidates to the exact-topic match so the topic wins, while
  // preserving exact entity matches (e.g. lower(id) = slug) and KNOWN_COMPANY
  // overrides that point at a specific entity id.
  const exactTopic = deduped.some(m => m.target_type === 'topic');
  if (exactTopic) {
    const filtered = deduped.filter(m => {
      if (m.target_type === 'topic') return true;
      // Keep entity candidates only when they are exact id/slug matches —
      // those are deliberate aliases (e.g. KNOWN_COMPANY_TARGETS) or precise
      // slug-equal entity references, not fuzzy LIKE noise.
      const idLower = String(m.target_id || '').toLowerCase();
      return idLower === slug || idLower === lower;
    });
    return { raw, matches: filtered };
  }
  return { raw, matches: deduped };
}

export function resolveWorkbench(db, args = {}, options = {}) {
  let wb = null;
  if (args.id) wb = getWorkbench(db, args.id);
  let resolvedTarget = null;
  if (!wb) {
    const candidates = args.target_type && args.target_id
      ? [{ target_type: args.target_type, target_id: args.target_id }]
      : resolveCandidateTargets(db, args.target || args.query);
    const candidateMatches = Array.isArray(candidates) ? candidates : candidates.matches;
    const duplicateType = Array.isArray(candidates) ? null : duplicateEntityType(candidateMatches);
    const matches = findWorkbenchesForTargets(db, candidateMatches);
    const exactTopicWorkbench = matches.some(match => match.target_type === 'topic');
    if (duplicateType && !exactTopicWorkbench) {
      throw new Error(`ambiguous entity target: ${Array.isArray(candidates) ? args.target || args.query : candidates.raw}`);
    }
    if (matches.length === 1) {
      resolvedTarget = { target_type: matches[0].target_type, target_id: matches[0].target_id };
      wb = getWorkbench(db, matches[0].id);
    } else if (matches.length > 1) {
      const targetKeys = new Set(matches.map(match => `${match.target_type}:${match.target_id}`));
      if (targetKeys.size > 1) throw new Error(`ambiguous workbench target: ${args.target || args.query}`);
      resolvedTarget = { target_type: matches[0].target_type, target_id: matches[0].target_id };
      wb = getWorkbench(db, matches[0].id);
    }
  }
  if (!wb) throw new Error(`no registered workbench found for ${args.id || args.target || args.query}`);

  const repoRoot = options.repoRoot || REPO_ROOT;
  let index = {};
  if (wb.resume_path && existsSync(resolve(repoRoot, wb.resume_path))) {
    index = parseResumeIndex(readFileSync(resolve(repoRoot, wb.resume_path), 'utf8'));
  }
  const synthesis = readWorkbenchSynthesis(wb.root_path, { repoRoot });
  const fromLog = projectionFromLog(wb.root_path, repoRoot);
  const logState = fromLog.latestState && !isScaffoldProjection(fromLog.latestState)
    ? fromLog.latestState
    : '';
  const logNext = fromLog.nextAction && !isScaffoldProjection(fromLog.nextAction)
    ? fromLog.nextAction
    : '';
  const synState = synthesis.latest_state && !isScaffoldProjection(synthesis.latest_state)
    ? synthesis.latest_state
    : '';
  const synNext = synthesis.next_action && !isScaffoldProjection(synthesis.next_action)
    ? synthesis.next_action
    : '';
  const latestPromotion = db.prepare(`
    SELECT promoted_at FROM workbench_promotions WHERE workbench_id = ? ORDER BY promoted_at DESC LIMIT 1
  `).get(wb.id);

  db.prepare(`UPDATE workbenches SET last_resumed_at = datetime('now') WHERE id = ?`).run(wb.id);

  const payload = {
    workbench_id: wb.id,
    title: wb.title,
    status: wb.status,
    root: wb.root_path,
    attachments: wb.attachments,
    current_question: index.current_question || wb.current_question || wb.summary || '',
    latest_state: logState
      || synState
      || index.latest_state
      || (!isScaffoldProjection(wb.latest_state) ? wb.latest_state : '')
      || fromLog.latestState
      || synthesis.latest_state
      || wb.latest_state
      || wb.summary
      || '',
    next_action: logNext
      || synNext
      || index.next_action
      || wb.next_action
      || fromLog.nextAction
      || synthesis.next_action
      || '',
    distillation_contract: index.distillation_contract?.length ? index.distillation_contract : defaultDistillationContract({
      current_question: index.current_question || wb.current_question || wb.summary || '',
      summary: wb.summary || '',
      canonical_promotion_targets: mergePromotionTargets(wb.attachments, index.canonical_promotion_targets),
    }),
    open_decisions: index.open_decisions || [],
    unresolved_questions: index.unresolved_questions || [],
    related_entities: mergeRelatedEntities(wb.attachments, index.related_entities),
    canonical_promotion_targets: mergePromotionTargets(wb.attachments, index.canonical_promotion_targets),
    indexed_substrate: summarizeItems(wb.items),
    minimum_boot: index.minimum_boot?.length ? index.minimum_boot : [wb.resume_path || wb.root_path].filter(Boolean),
    deep_links: index.deep_links?.length ? index.deep_links : [wb.root_path, ...wb.items.slice(0, 12).map(item => item.path)],
    last_activity_at: wb.last_activity_at || newestMtime(wb.items.map(item => item.path), repoRoot) || wb.updated_at,
    last_promotion_at: latestPromotion?.promoted_at || null,
  };
  return payload;
}

function readWorkbenchSynthesis(rootPath, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const path = resolve(repoRoot, rootPath || '', 'SYNTHESIS.md');
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  const bodyLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const latest = bodyLines.find((line) => !/^next action\s*:/i.test(line)) || '';
  const nextMatch = text.match(/(?:^|\n)\s*(?:[-*]\s*)?next action\s*:\s*(.+?)(?=\n|$)/i);
  return {
    latest_state: latest,
    next_action: nextMatch ? nextMatch[1].trim() : '',
  };
}

function duplicateEntityType(matches) {
  for (const type of ['person', 'company', 'place']) {
    const typed = matches.filter(match => match.target_type === type);
    if (typed.length > 1) return type;
  }
  return null;
}

function findWorkbenchesForTargets(db, targets) {
  const rows = [];
  const query = db.prepare(`
    SELECT w.id, a.target_type, a.target_id, a.role, w.last_activity_at
    FROM workbenches w
    JOIN workbench_attachments a ON a.workbench_id = w.id
    WHERE a.target_type = ? AND a.target_id = ? AND w.status != 'archived'
    ORDER BY CASE a.role WHEN 'primary' THEN 0 ELSE 1 END, w.last_activity_at DESC, w.updated_at DESC
  `);
  for (const target of targets) {
    rows.push(...query.all(target.target_type, target.target_id));
  }
  rows.sort((a, b) => {
    const typeRank = (row) => row.target_type === 'topic' ? 0 : 1;
    const roleRank = (row) => row.role === 'primary' ? 0 : 1;
    return typeRank(a) - typeRank(b)
      || roleRank(a) - roleRank(b)
      || String(b.last_activity_at || '').localeCompare(String(a.last_activity_at || ''));
  });
  const seen = new Set();
  return rows.filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}


export function validateResumePayload(payload) {
  const missing = REQUIRED_RESUME_FIELDS.filter(field => {
    const value = payload[field];
    if (field === 'last_promotion_at') return value === undefined;
    if (Array.isArray(value)) return value.length === 0 && !['open_decisions', 'unresolved_questions', 'related_entities'].includes(field);
    return value === undefined || value === null || value === '';
  });
  return { ok: missing.length === 0, missing };
}

export function summarizeItems(items = []) {
  const byKind = {};
  const freshness = { current: 0, stale: 0, unresolved: 0, promoted: 0 };
  for (const item of items) {
    byKind[item.kind] = (byKind[item.kind] || 0) + 1;
    freshness[item.status] = (freshness[item.status] || 0) + 1;
  }
  return {
    total: items.length,
    by_kind: byKind,
    freshness,
    items: items.slice(0, 20).map(item => ({
      id: item.id,
      kind: item.kind,
      path: item.path,
      status: item.status,
      content_hash: item.content_hash,
    })),
  };
}

function mergeRelatedEntities(attachments, fromIndex = []) {
  const entities = attachments
    .filter(a => a.target_type !== 'topic')
    .map(a => ({ target_type: a.target_type, target_id: a.target_id, role: a.role, label: a.label || '' }));
  return [...entities, ...fromIndex.map(value => typeof value === 'string' ? { label: value } : value)];
}

function mergePromotionTargets(attachments, fromIndex = []) {
  const targets = attachments.map(a => ({
    target_type: a.target_type,
    target_id: a.target_id,
    role: a.role,
    label: a.label || '',
  }));
  return [...targets, ...fromIndex.map(value => typeof value === 'string' ? { label: value } : value)];
}

function parseJson(value) {
  try { return value ? JSON.parse(value) : {}; }
  catch { return {}; }
}

function titleFromSlug(slug) {
  return String(slug).split(/[-_]/).filter(Boolean).map(s => s[0]?.toUpperCase() + s.slice(1)).join(' ');
}

export function slugify(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function topicWorkbenchRoot(db, slug, workbenchId) {
  const contextPath = topicContextPath(db, slug);
  const owner = contextOwnerRoot(contextPath).replace(new RegExp(`^${USER_CONTEXTS_REL}/topics/?`), '');
  return `${USER_WORKBENCHES_REL}/topics/${owner}/${workbenchId}`.replace(/\/+/g, '/');
}

export function entityWorkbenchRoot(type, id, db, workbenchId) {
  const owner = entityOwnerRoot(type, id, db).replace(new RegExp(`^${USER_CONTEXTS_REL}/[^/]+/?`), '');
  return `${USER_WORKBENCHES_REL}/entities/${entityDir(type)}/${owner}/${workbenchId}`.replace(/\/+/g, '/');
}

export function appendContextPointer(filePath, pointer, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const abs = resolve(repoRoot, filePath);
  mkdirSync(dirname(abs), { recursive: true });
  const marker = `Workbench: ${pointer}`;
  const titleSeed = basename(filePath) === 'context.md' ? basename(dirname(filePath)) : basename(filePath, '.md');
  const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : `# ${titleFromSlug(titleSeed)}\n`;
  if (existing.includes(marker)) return false;
  if (/(^|\n)## Workbench\n/.test(existing)) {
    writeFileSync(abs, existing.replace(/(^|\n)## Workbench\n+/, `$1## Workbench\n\n- ${marker}\n\n`));
    return true;
  }
  writeFileSync(abs, `${existing.trimEnd()}\n\n## Workbench\n\n- ${marker}\n`);
  return true;
}

export function topicContextPath(db, slug) {
  return packageTopicContextPath(db, slug);
}

export function abandonTopicWorkbenches(db, slug, options = {}) {
  if (!slug) return { removed: 0 };
  const repoRoot = options.repoRoot || REPO_ROOT;
  const topicsRoot = resolve(repoRoot, USER_WORKBENCHES_REL, 'topics');
  const rows = db.prepare(`
    SELECT w.id, w.root_path
    FROM workbenches w
    JOIN workbench_attachments a ON a.workbench_id = w.id
    WHERE a.target_type = 'topic'
      AND a.target_id = ?
  `).all(slug);
  for (const row of rows) {
    if (row.root_path) {
      const abs = resolve(repoRoot, row.root_path);
      if (abs === topicsRoot || abs.startsWith(topicsRoot + '/')) {
        try { rmSync(abs, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    }
    db.prepare('DELETE FROM workbenches WHERE id = ?').run(row.id);
  }
  return { removed: rows.length };
}

export function ensureDefaultTopicWorkbench(db, slug, options = {}) {
  const row = db.prepare(`
    SELECT slug, label, parent_slug
    FROM user_topics
    WHERE slug = ?
  `).get(slug);
  if (!row) throw new Error(`topic not found: ${slug}`);

  const existing = db.prepare(`
    SELECT w.id
    FROM workbenches w
    JOIN workbench_attachments a ON a.workbench_id = w.id
    WHERE a.target_type = 'topic'
      AND a.target_id = ?
      AND COALESCE(a.role, 'primary') = 'primary'
      AND w.status != 'archived'
    ORDER BY CASE a.role WHEN 'primary' THEN 0 ELSE 1 END, w.updated_at DESC
    LIMIT 1
  `).get(slug);
  if (existing) return getWorkbench(db, existing.id);

  return registerWorkbench(db, defaultTopicWorkbenchSpec(db, row), options);
}

export function ensureDefaultEntityWorkbench(db, type, id, options = {}) {
  const kind = String(type || '').trim();
  const entityId = String(id || '').trim();
  if (!kind || !entityId) return null;
  const existing = primaryWorkbenchForTarget(db, kind, entityId);
  if (existing) return getWorkbench(db, existing.id) || existing;
  return registerWorkbench(db, { target: `${kind}:${entityId}` }, options);
}

export function repointTopicWorkbenches(db, args, options = {}) {
  const fromSlug = args.fromSlug;
  const toSlug = args.toSlug;
  if (!fromSlug || !toSlug || fromSlug === toSlug) return { updated: 0 };
  const fromContextPath = args.fromContextPath || topicContextPath(db, fromSlug);
  const toContextPath = args.toContextPath || topicContextPath(db, toSlug);
  const toRow = db.prepare(`SELECT slug, label, parent_slug FROM user_topics WHERE slug = ?`).get(toSlug);
  const rows = topicWorkbenchRows(db, fromSlug);
  for (const row of rows) {
    moveTopicWorkbenchHome(db, {
      workbenchId: row.id,
      fromContextPath,
      toContextPath,
      fromSlug,
      toSlug,
      repoRoot: options.repoRoot,
    });
  }
  db.prepare(`
    UPDATE workbench_attachments
    SET target_id = ?,
        label = COALESCE(NULLIF(?, ''), label),
        metadata = json_set(COALESCE(NULLIF(metadata, ''), '{}'), '$.parent_slug', ?)
    WHERE target_type = 'topic'
      AND target_id = ?
  `).run(toSlug, toRow?.label || '', toRow?.parent_slug || '', fromSlug);
  return { updated: rows.length };
}

export function rehomeTopicWorkbenches(db, args, options = {}) {
  const topicSlug = args.topicSlug;
  if (!topicSlug) return { updated: 0 };
  const rows = topicWorkbenchRows(db, topicSlug);
  for (const row of rows) {
    moveTopicWorkbenchHome(db, {
      workbenchId: row.id,
      fromContextPath: args.fromContextPath,
      toContextPath: args.toContextPath,
      repoRoot: options.repoRoot,
    });
  }
  return { updated: rows.length };
}

function topicWorkbenchRows(db, topicSlug) {
  return db.prepare(`
    SELECT w.id
    FROM workbenches w
    JOIN workbench_attachments a ON a.workbench_id = w.id
    WHERE a.target_type = 'topic'
      AND a.target_id = ?
  `).all(topicSlug);
}

function defaultTopicWorkbenchSpec(db, topic) {
  const id = `wk_${slugify(topic.slug).replace(/-/g, '_')}`;
  const root = topicWorkbenchRoot(db, topic.slug, id);
  return {
    id,
    slug: `${topic.slug}-workbench`,
    title: `${topic.label || titleFromSlug(topic.slug)} Workbench`,
    root_path: root,
    resume_path: `${root}/INDEX.md`,
    attachment: {
      target_type: 'topic',
      target_id: topic.slug,
      role: 'primary',
      label: topic.label || titleFromSlug(topic.slug),
      parent_slug: topic.parent_slug || '',
    },
    current_question: `Continue work for ${topic.label || titleFromSlug(topic.slug)}.`,
    latest_state: 'Default topic workbench created as the canonical landing zone for deep work.',
    next_action: 'Use this workbench for research, analysis, todos, renderings, and long-form synthesis; promote durable compact truth into the topic context.',
  };
}

function defaultCompanyWorkbenchSpec(db, target) {
  const id = `wk_${slugify(target.target_id).replace(/-/g, '_')}`;
  const root = entityWorkbenchRoot('company', target.target_id, db, id);
  return {
    id,
    slug: `${target.target_id}-workbench`,
    title: `${target.label || titleFromSlug(target.target_id)} Workbench`,
    root_path: root,
    resume_path: `${root}/INDEX.md`,
    attachment: {
      target_type: 'company',
      target_id: target.target_id,
      role: 'primary',
      label: target.label || titleFromSlug(target.target_id),
    },
    current_question: `Continue company work for ${target.label || titleFromSlug(target.target_id)}.`,
    latest_state: 'Company workbench created as the canonical landing zone for entity-specific deep work.',
    next_action: 'Use this workbench for entity research and promote durable compact facts into the canonical company context.',
  };
}

function resolvedDefaultWorkbenchSpec(db, target) {
  const resolved = resolveTarget(db, target);
  if (resolved.target_type === 'topic') {
    const row = db.prepare(`SELECT slug, label, parent_slug FROM user_topics WHERE slug = ?`).get(resolved.target_id);
    return defaultTopicWorkbenchSpec(db, row || { slug: resolved.target_id, label: resolved.label || titleFromSlug(resolved.target_id) });
  }
  if (resolved.target_type === 'company') return defaultCompanyWorkbenchSpec(db, resolved);
  if (resolved.target_type === 'person') {
    const id = `wk_${slugify(resolved.target_id).replace(/-/g, '_')}`;
    const root = entityWorkbenchRoot('person', resolved.target_id, db, id);
    return {
      id,
      slug: `${resolved.target_id}-workbench`,
      title: `${resolved.label || titleFromSlug(resolved.target_id)} Workbench`,
      root_path: root,
      resume_path: `${root}/INDEX.md`,
      attachment: { target_type: 'person', target_id: resolved.target_id, role: 'primary', label: resolved.label || '' },
    };
  }
  if (resolved.target_type === 'place') {
    const id = `wk_${slugify(resolved.target_id).replace(/-/g, '_')}`;
    const root = entityWorkbenchRoot('place', resolved.target_id, db, id);
    return {
      id,
      slug: `${resolved.target_id}-workbench`,
      title: `${resolved.label || titleFromSlug(resolved.target_id)} Workbench`,
      root_path: root,
      resume_path: `${root}/INDEX.md`,
      attachment: { target_type: 'place', target_id: resolved.target_id, role: 'primary', label: resolved.label || '' },
    };
  }
  return null;
}

function moveTopicWorkbenchHome(db, args) {
  const wb = getWorkbench(db, args.workbenchId);
  if (!wb) return false;
  const repoRoot = args.repoRoot || REPO_ROOT;
  const fromBase = contextOwnerRoot(args.fromContextPath || '');
  const toBase = contextOwnerRoot(args.toContextPath || '');
  const fromTopBase = contextPathToWorkbenchBase(args.fromContextPath || '');
  const toTopBase = contextPathToWorkbenchBase(args.toContextPath || '');
  const oldRoot = wb.root_path || `${fromTopBase}/${wb.id}`;
  const oldResume = wb.resume_path || `${oldRoot}/INDEX.md`;
  const newRoot = oldRoot.startsWith(`${fromTopBase}/`)
    ? oldRoot.replace(`${fromTopBase}/`, `${toTopBase}/`)
      : `${toTopBase}/${wb.id}`;
  const newResume = oldResume.startsWith(`${fromTopBase}/`)
    ? oldResume.replace(`${fromTopBase}/`, `${toTopBase}/`)
    : `${newRoot}/INDEX.md`;
  movePathIfPresent(oldRoot, newRoot, repoRoot);
  rewritePathReferences(newResume, [
    [oldResume, newResume],
    [oldRoot, newRoot],
    [fromBase, toBase],
    [args.fromSlug, args.toSlug],
  ], repoRoot);
  db.prepare(`
    UPDATE workbenches
    SET root_path = ?,
        resume_path = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(newRoot, newResume, wb.id);
  db.prepare(`
    UPDATE workbench_items
    SET path = CASE
          WHEN path = ? THEN ?
          WHEN path LIKE ? THEN ? || substr(path, ?)
          ELSE path
        END,
        updated_at = datetime('now')
    WHERE workbench_id = ?
      AND (path = ? OR path LIKE ?)
  `).run(oldResume, newResume, `${oldRoot}/%`, newRoot, oldRoot.length + 1, wb.id, oldResume, `${oldRoot}/%`);
  appendContextPointer(args.toContextPath, newResume, { repoRoot });
  return true;
}

function contextPathToWorkbenchBase(contextPath) {
  const owner = contextOwnerRoot(contextPath).replace(new RegExp(`^${USER_CONTEXTS_REL}/topics/?`), '');
  return `${USER_WORKBENCHES_REL}/topics/${owner}`.replace(/\/+/g, '/');
}

function movePathIfPresent(fromPath, toPath, repoRoot) {
  const fromAbs = resolve(repoRoot, fromPath);
  const toAbs = resolve(repoRoot, toPath);
  if (!existsSync(fromAbs) || fromAbs === toAbs || existsSync(toAbs)) return false;
  mkdirSync(dirname(toAbs), { recursive: true });
  renameSync(fromAbs, toAbs);
  return true;
}

function rewritePathReferences(path, replacements, repoRoot) {
  const abs = resolve(repoRoot, path);
  if (!existsSync(abs)) return false;
  let content = readFileSync(abs, 'utf8');
  let next = content;
  for (const [from, to] of replacements) {
    if (!from || !to || from === to) continue;
    next = next.split(from).join(to);
  }
  if (next === content) return false;
  writeFileSync(abs, next);
  return true;
}

function defaultWorkbenchResumePath(db, spec, attachments) {
  if (spec.root_path?.startsWith(`${USER_WORKBENCHES_REL}/`)) return `${spec.root_path.replace(/\/+$/, '')}/INDEX.md`;
  const primary = attachments.find(a => (a.role || 'primary') === 'primary') || attachments[0];
  const id = spec.id;
  if (primary.target_type === 'topic') return `${topicWorkbenchRoot(db, primary.target_id, id)}/INDEX.md`;
  if (primary.target_type === 'person') return `${entityWorkbenchRoot('person', primary.target_id, db, id)}/INDEX.md`;
  if (primary.target_type === 'company') return `${entityWorkbenchRoot('company', primary.target_id, db, id)}/INDEX.md`;
  if (primary.target_type === 'place') return `${entityWorkbenchRoot('place', primary.target_id, db, id)}/INDEX.md`;
  throw new Error(`unsupported workbench attachment type: ${primary.target_type}`);
}

function appendPointerForAttachment(db, attachment, resumePath, options = {}) {
  if (attachment.target_type === 'topic') {
    appendContextPointer(topicContextPath(db, attachment.target_id), resumePath, options);
  } else if (attachment.target_type === 'person') {
    appendContextPointer(entityContextPath('person', attachment.target_id, db), resumePath, options);
  } else if (attachment.target_type === 'company') {
    appendContextPointer(entityContextPath('company', attachment.target_id, db), resumePath, options);
  } else if (attachment.target_type === 'place') {
    appendContextPointer(entityContextPath('place', attachment.target_id, db), resumePath, options);
  }
}

// Topic-slug denylist for the disk-scan workbench reconcile.
//
// WHY a denylist and not an allowlist of known workbench slugs: a user's topic
// and workbench slugs are PII and must never enter committed code (the PII
// gate enforces this). The user's workbench filesystem is gitignored; its
// directory layout is the source of truth. The denylist names only the known
// maintenance/test artifacts that share the same `user/workbenches/topics/` shape
// but are NOT real workbenches.
//
// `maint-new-topic` is produced by the topic-lifecycle maintenance tooling
// when exercising default-topic-workbench creation; it must not be registered
// as a durable workbench.
const WORKBENCH_TOPIC_DENYLIST = new Set([
  'maint-new-topic',
  'tool-child',
  'tool-parent',
  'api-define',
  'recap-live',
]);

function isGeneratedQaWorkbenchTopicSlug(slug) {
  return isJunkTopicSlug(slug) || /^(qa-persist|qa-rename-modal|qa-probe)-/.test(String(slug || ''));
}

// Discover candidate workbenches by scanning the on-disk gitignored
// user/workbenches tree. Returns one entry per real workbench directory:
//   {
//     id,                // workbench id == basename of dir (e.g. wk_xxxxxxx)
//     root_path,         // repo-relative path to the dir
//     resume_path,       // root_path + '/INDEX.md'
//     topic_slug,        // last path segment under topics/{...}/ before wk_*
//     parent_slug,       // the segment above topic_slug, '' for depth-1 topics
//   }
//
// Filter rules (the "real workbench" rule):
//   1) Path matches `user/workbenches/topics/{...slugs...}/wk_*` with at least one
//      topic segment between `topics/` and the wk_* dir.
//   2) Directory contains an INDEX.md (the resume contract). Without it the
//      dir is not a workbench; absence is the disqualifier.
//   3) The topic_slug (the immediate parent of wk_*) is not in
//      WORKBENCH_TOPIC_DENYLIST.
//
// Dedup: when the same workbench id appears under multiple paths (a stray
// misplaced copy, e.g. an orphaned `topics/{slug}/wk_*` mirror of the canonical
// `topics/{parent}/{slug}/wk_*`), the entry with the deeper, parented path
// wins — the parented `primary_target` shape (`work/robot-dojo`) is canonical.
// Strays are surfaced via `strays` so the owner can clean them up.
export function scanWorkbenchesFromDisk(repoRoot) {
  const root = resolve(repoRoot, USER_WORKBENCHES_REL, 'topics');
  if (!existsSync(root)) return { entries: [], strays: [] };
  const found = [];
  // `segments` is the path from `user/workbenches/topics/` to the current dir,
  // INCLUSIVE. For the initial call (absPath = user/workbenches/topics) segments
  // is empty. For a child `topics/{parent}/{slug}/wk_xxxxxxx`, segments is
  // ['{parent}', '{slug}', 'wk_xxxxxxx'].
  walk(root, []);
  return dedupeWorkbenchEntries(found);

  function walk(absPath, segments) {
    const base = basename(absPath);
    // A workbench dir is `wk_*` sitting under at least one topic segment.
    // segments.length >= 2 because the wk_* basename itself is the last
    // segment, and at least one topic ancestor must precede it.
    const isWorkbenchDir = base.startsWith('wk_') && segments.length >= 2;
    if (isWorkbenchDir) {
      const resumeAbs = resolve(absPath, 'INDEX.md');
      if (!existsSync(resumeAbs)) return;
      // The topic slug is the segment immediately above the wk_* dir.
      const topicSlug = segments[segments.length - 2];
      if (WORKBENCH_TOPIC_DENYLIST.has(topicSlug) || isGeneratedQaWorkbenchTopicSlug(topicSlug)) return;
      const parentSlug = segments.length >= 3 ? segments[segments.length - 3] : '';
      const rootPath = `${USER_WORKBENCHES_REL}/topics/${segments.join('/')}`;
      found.push({
        id: base,
        root_path: rootPath,
        resume_path: `${rootPath}/INDEX.md`,
        topic_slug: topicSlug,
        parent_slug: parentSlug,
      });
      // Do NOT descend into a workbench directory. Some on-disk trees
      // contain nested `wk_*/wk_*` directories (owner sync artifacts);
      // these are not separate workbenches and would otherwise produce
      // phantom registrations with the wk_* basename incorrectly used as
      // the topic slug.
      return;
    }
    let children;
    try { children = readdirSync(absPath); } catch { return; }
    for (const child of children) {
      const childAbs = resolve(absPath, child);
      let st;
      try { st = lstatSync(childAbs); } catch { continue; }
      if (!st.isDirectory()) continue;
      walk(childAbs, [...segments, child]);
    }
  }
}

function dedupeWorkbenchEntries(entries) {
  const byId = new Map();
  const strays = [];
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (!existing) { byId.set(entry.id, entry); continue; }
    // Prefer the entry with the longer (more nested) path — canonical
    // `topics/{parent}/{slug}/wk_*` wins over `topics/{slug}/wk_*`.
    const winner = entry.root_path.length > existing.root_path.length ? entry : existing;
    const loser = winner === entry ? existing : entry;
    byId.set(entry.id, winner);
    strays.push(loser.root_path);
  }
  return { entries: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), strays };
}

function titleFromIndex(absResumePath, fallback) {
  try {
    const text = readFileSync(absResumePath, 'utf8');
    const match = text.match(/^#\s+(.+?)\s*$/m);
    if (match) return match[1].trim();
  } catch { /* fall through */ }
  return fallback;
}

// Cheap content signature for a workbench root directory.
//
// Walks the tree stat-only — NO file reads, NO content hashing — and returns
// { file_count, max_mtime_ms }. The cost is one lstat per filesystem entry; on
// the largest known workbench (~675 files) this completes in well under
// 100ms, vs. multi-second cost of scanWorkbenchRoot which reads file content
// to classify items and compute SHA-256 hashes.
//
// WHY this signature shape: file count covers add/remove, max mtime covers
// edit-in-place. The pair changes iff the on-disk substrate changed. Mtime
// alone misses pure deletions; count alone misses pure edits. SHA-tree-hash
// would be more rigorous but reading every file's bytes on every boot is the
// exact cost we are avoiding.
//
// Excludes the same noise scanWorkbenchRoot excludes (.git, node_modules) so
// signatures stay stable across environments that drop a .git into the tree.
export function computeWorkbenchSignature(rootPath, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const absRoot = resolve(repoRoot, rootPath);
  let fileCount = 0;
  let maxMtimeMs = 0;
  if (!existsSync(absRoot)) return { file_count: 0, max_mtime_ms: 0 };
  walk(absRoot);
  return { file_count: fileCount, max_mtime_ms: Math.round(maxMtimeMs) };

  function walk(absPath) {
    let st;
    try { st = lstatSync(absPath); } catch { return; }
    if (st.isDirectory()) {
      const base = basename(absPath);
      if (base === 'node_modules' || base === '.git') return;
      let children;
      try { children = readdirSync(absPath); } catch { return; }
      for (const child of children) walk(resolve(absPath, child));
      return;
    }
    if (!st.isFile()) return;
    fileCount += 1;
    if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
  }
}

function signaturesEqual(a, b) {
  if (!a || !b) return false;
  return a.file_count === b.file_count && a.max_mtime_ms === b.max_mtime_ms;
}

// Cheap row-only refresh for a workbench whose on-disk content
// signature is unchanged since the last full registration. Skips:
//   - scanWorkbenchRoot (the expensive part — reads + hashes every file)
//   - upsertWorkbenchItems (the row churn — would re-touch every item row)
//   - ensureResumePointer (INDEX.md write — preserved by the on-disk version)
//
// Does the cheap, always-do-it work:
//   - Parse INDEX.md (single file read) and refresh current_question /
//     latest_state / next_action on the workbenches row. Owner edits the
//     INDEX between boots; the row must reflect those edits even when no
//     substrate file changed.
//   - Update last_activity_at conservatively (kept at existing row value if
//     present; we do not touch updated_at unless a refresh field changed).
//
// Returns the workbench id when a refresh happened, or null when nothing
// needed updating.
function cheapResumeRefresh(db, row, entry, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const resumeAbs = resolve(repoRoot, entry.resume_path);
  if (!existsSync(resumeAbs)) return null;
  const parsed = parseResumeIndex(readFileSync(resumeAbs, 'utf8'));
  const nextCq = parsed.current_question || row.current_question || '';
  const nextLs = parsed.latest_state || row.latest_state || '';
  const nextNa = parsed.next_action || row.next_action || '';
  if (
    nextCq === (row.current_question || '') &&
    nextLs === (row.latest_state || '') &&
    nextNa === (row.next_action || '')
  ) {
    return null;
  }
  db.prepare(`
    UPDATE workbenches
    SET current_question = ?,
        latest_state = ?,
        next_action = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(nextCq, nextLs, nextNa, row.id);
  return row.id;
}

// Durable, idempotent workbench registration via disk-scan. Runs for every
// user (owner and customer alike) against their own on-disk gitignored
// `user/workbenches/topics/**/wk_*/` tree.
//
// WHY this runs for all users, not just owner mode: a customer who uses the
// product writes their workbench substrate into the same `user/workbenches/topics/`
// tree (`topicWorkbenchRoot` is the canonical writer for everyone). On a fresh
// install the tree is empty so the scan is a no-op — the bare-customer-start
// invariant is preserved by the empty filesystem, not by an owner-mode gate.
// On a subsequent boot after the customer has done real work, the every-boot
// reconcile is the structure that guarantees the customer's workbenches
// survive a DB rebuild. Gating this on owner mode would deny customers durable
// registration and reproduce the st_f0196b64 customer-facing defect on
// customer installs.
//
// WHY every-boot reconcile, not a one-shot migration: a migration runs exactly
// once per DB (the ledger row blocks re-runs). Any workbench added to disk
// AFTER the first run could not enter the DB without manually clearing the
// ledger or rebuilding the whole DB. Neither qualifies as durable. Every-boot
// reconcile is the only structure that makes "new workbench on disk →
// registered next boot" a guarantee. (Root cause: st_f0196b64.)
//
// Boot-cost discipline: the full registration path
// (scanWorkbenchRoot → upsertWorkbenchItems) reads every file under the
// workbench root and re-touches every item row. On the largest known
// workbench (~675 files) that is multi-second work. We cannot do that on
// every boot.
//
// Cheap content signature (file_count, max_mtime_ms) is computed for each
// on-disk workbench. When the signature matches the one persisted in the
// workbench row's metadata.disk_signature, we skip the full path and do
// only a cheap INDEX.md re-read + workbenches-row resume-pointer refresh.
// The signature is updated AFTER a successful full registration so the next
// boot can short-circuit. On a steady-state second boot with nothing changed,
// the total work per workbench is: one lstat tree walk (cheap) + at most one
// INDEX.md read.
//
// Source of truth: the on-disk `user/workbenches/topics/**/wk_*/` tree. Workbench
// slugs live ONLY in the user's gitignored filesystem; this code carries no
// hardcoded user identifiers.
//
// Idempotency: registerWorkbench uses ON CONFLICT upserts for workbenches,
// workbench_attachments, and workbench_items, and we pass
// preserveExistingIndex so the on-disk INDEX.md is treated as authoritative
// (the user-curated resume content is not flattened by the spec-driven
// rewrite). Re-running this function with an unchanged tree produces zero
// row delta beyond the cheap resume-pointer refresh.
//
// Returns: {
//   registered: [<id>...],         // full register (new or changed signature)
//   refreshed:  [<id>...],         // cheap row-only refresh, signature match
//   unchanged:  [<id>...],         // signature match AND resume fields match
//   skipped:    [<reason>...],
//   strays:     [<path>...],       // duplicate workbench-id dirs not registered
// }
export function reconcileWorkbenchesFromDisk(db, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const { entries, strays } = scanWorkbenchesFromDisk(repoRoot);
  const registered = [];
  const refreshed = [];
  const unchanged = [];
  const skipped = [];

  const getRow = db.prepare(`
    SELECT id, slug, root_path, resume_path,
           current_question, latest_state, next_action,
           metadata, last_activity_at
    FROM workbenches
    WHERE id = ?
  `);
  const updateMetadata = db.prepare(`
    UPDATE workbenches
    SET metadata = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `);
  const getTopicLabel = db.prepare(`SELECT label FROM user_topics WHERE slug = ?`);

  for (const entry of entries) {
    try {
      const resumeAbs = resolve(repoRoot, entry.resume_path);
      const title = titleFromIndex(resumeAbs, titleFromSlug(entry.topic_slug));
      const topicLabel = getTopicLabel.get(entry.topic_slug)?.label || titleFromSlug(entry.topic_slug);
      const slug = `${entry.topic_slug}-workbench`;
      const existing = getRow.get(entry.id);
      const currentSig = computeWorkbenchSignature(entry.root_path, { repoRoot });
      const storedMeta = parseJson(existing?.metadata);
      const storedSig = storedMeta.disk_signature;

      // Fast path: row exists AND signature matches. Skip the expensive
      // scan/re-index. Do only the cheap INDEX.md re-read + row resume
      // pointer refresh so owner edits to INDEX.md still propagate.
      if (existing && signaturesEqual(storedSig, currentSig)) {
        const refreshedId = cheapResumeRefresh(db, existing, entry, { repoRoot });
        if (refreshedId) refreshed.push(refreshedId);
        else unchanged.push(entry.id);
        continue;
      }

      // Slow path: row missing OR signature changed. Run the full
      // registerWorkbench path (scan + item upsert + RAG-ready).
      const parsed = existsSync(resumeAbs) ? parseResumeIndex(readFileSync(resumeAbs, 'utf8')) : {};
      const wb = registerWorkbench(
        db,
        {
          id: entry.id,
          slug,
          title,
          root_path: entry.root_path,
          resume_path: entry.resume_path,
          current_question: parsed.current_question || '',
          latest_state: parsed.latest_state || '',
          next_action: parsed.next_action || '',
	          attachment: {
	            target_type: 'topic',
	            target_id: entry.topic_slug,
	            role: 'primary',
	            label: topicLabel,
	            parent_slug: entry.parent_slug || '',
	          },
        },
        { repoRoot, maxFiles: options.maxFiles || 5000, preserveExistingIndex: true },
      );

      // Persist the post-registration signature alongside any owner-supplied
      // metadata so the next boot can short-circuit. The full registration path
      // may preserve or create resume/pointer files, so a pre-registration
      // signature can be stale before it is stored.
      const finalRow = getRow.get(entry.id);
      const finalMeta = parseJson(finalRow?.metadata);
      finalMeta.disk_signature = computeWorkbenchSignature(entry.root_path, { repoRoot });
      updateMetadata.run(JSON.stringify(finalMeta), entry.id);
      registered.push(wb.id);
    } catch (error) {
      skipped.push(`error:${entry.id}:${error.message}`);
    }
  }
  return { registered, refreshed, unchanged, skipped, strays };
}

// dryRunFixture remains for scripts/workbench-index.js --dry-run, which
// inspects fixture-based targets without touching the DB. Throws on
// unknown targets so callers cannot silently no-op.
export function dryRunFixture(target, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const fixture = fixtureForTarget(target, { repoRoot });
  if (!fixture) throw new Error(`unknown fixture target: ${target}`);
  const rootPath = existsSync(resolve(repoRoot, fixture.root_path)) ? fixture.root_path : dirname(fixture.resume_path);
  const items = collectItemsForSpec(fixture, rootPath, { repoRoot, maxFiles: options.maxFiles });
  return {
    dry_run: true,
    workbench: fixture,
    attachments: normalizeAttachments(fixture),
    items,
    resume_path: fixture.resume_path,
  };
}
