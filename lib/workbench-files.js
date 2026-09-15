import crypto from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  USER_CONTEXTS_REL,
  USER_DATABASES_REL,
  USER_FILES_REL,
  USER_TRANSCRIPTS_REL,
  USER_WORKBENCHES_REL,
} from './robotdojo-paths.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SUPPORTED_ITEM_KINDS = new Set([
  'note',
  'idea',
  'todo',
  'event_history',
  'analysis',
  'research',
  'report',
  'dataset',
  'database',
  'draft',
  'decision_log',
  'rendering',
  'visualization',
  'source_file',
  'status',
  'generated_view',
]);

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.csv',
  '.tsv',
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.sql',
]);

const KIND_PATTERNS = [
  ['status', /\b(session[-_ ]status|status|resume|next action|current state|latest state)\b/i],
  ['todo', /\b(todo|next[-_ ]steps?|action items?)\b/i],
  ['decision_log', /\b(decision|decisions|rationale|reviewed)\b/i],
  ['event_history', /\b(history|timeline|sequence of events|session log)\b/i],
  ['analysis', /\b(analysis|synthesis|research|dossier|findings|recommendation|fit score)\b/i],
  ['dataset', /\.(csv|tsv|xlsx?|json)$/i],
  ['database', /\.(db|sqlite|sqlite3)$/i],
  ['rendering', /\.(png|jpe?g|webp|gif|pdf)$/i],
  ['visualization', /\b(chart|dashboard|map|graph|html|view|render)\b/i],
  ['draft', /\b(draft|proposal|questionnaire|rfi|onboarding)\b/i],
  ['idea', /\b(idea|hypothesis|brainstorm)\b/i],
];

export const OWNER_DISCOVERY_SEEDS = [
  {
    key: 'career',
    paths: [
      `${USER_CONTEXTS_REL}/topics/work/career/context.md`,
      `${USER_WORKBENCHES_REL}/topics/work/career/wk_ecede903/substrate/legacy-docs/work/deep-tech-search-arc.md`,
    ],
    target: { type: 'topic', id: 'career' },
  },
  {
    key: 'health',
    paths: [
      `${USER_WORKBENCHES_REL}/topics/personal/health/wk_health/substrate/legacy-docs/personal/health`,
      `${USER_CONTEXTS_REL}/topics/personal/health/context.md`,
      `${USER_WORKBENCHES_REL}/topics/personal/health/wk_health/renderings/health-dashboard`,
      `${USER_DATABASES_REL}/health`,
    ],
    target: { type: 'topic', id: 'health' },
  },
  {
    key: 'coaching-deep-context',
    paths: [
      `${USER_WORKBENCHES_REL}/topics/personal/coaching/wk_coaching/substrate/legacy-docs/personal/coaching/historical`,
      `${USER_WORKBENCHES_REL}/topics/personal/coaching/wk_coaching/substrate/legacy-docs/personal/coaching/INDEX.md`,
      `${USER_CONTEXTS_REL}/topics/personal/coaching/context.md`,
    ],
    target: { type: 'topic', id: 'coaching' },
  },
  {
    key: 'deep-tech-research',
    paths: [
      `${USER_WORKBENCHES_REL}/topics/work/career/wk_ecede903/substrate/research/deep-tech-`,
      `${USER_WORKBENCHES_REL}/topics/work/career/wk_ecede903/substrate/research/companies`,
    ],
    target: { type: 'topic', id: 'career' },
  },
  {
    key: 'project-maple',
    paths: [
      `${USER_WORKBENCHES_REL}/topics/work/project-maple/wk_project_maple`,
      `${USER_WORKBENCHES_REL}/topics/work/project-maple/wk_project_maple/substrate/external-repo/projectmaple`,
    ],
    target: { type: 'topic', id: 'project-maple' },
  },
  {
    key: 'robot-dojo',
    paths: [
      `${USER_WORKBENCHES_REL}/topics/work/robot-dojo/wk_robot_dojo`,
      `${USER_CONTEXTS_REL}/topics/work/robot-dojo/context.md`,
    ],
    target: { type: 'topic', id: 'robot-dojo' },
  },
  {
    key: 'cedar',
    paths: [
      `${USER_WORKBENCHES_REL}/topics/work/cedar/wk_cedar`,
    ],
    target: { type: 'topic', id: 'cedar' },
  },
];

export const DISCOVERY_SEEDS = [];

function activeDiscoverySeeds(options = {}) {
  if (Array.isArray(options.discoverySeeds)) return options.discoverySeeds;
  if (options.includeOwnerSeeds || process.env.ROBOTDOJO_OWNER_MODE === '1') return OWNER_DISCOVERY_SEEDS;
  return DISCOVERY_SEEDS;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export function stableId(...parts) {
  return sha256(parts.filter(Boolean).join('|')).slice(0, 24);
}

export function toRepoPath(path, repoRoot = REPO_ROOT) {
  const abs = resolve(repoRoot, path);
  return relative(repoRoot, abs).split(sep).join('/');
}

export function resolveRepoPath(path, repoRoot = REPO_ROOT) {
  if (!path) return repoRoot;
  return resolve(repoRoot, path);
}

export function loadOntology(repoRoot = REPO_ROOT) {
  const rootLockPath = resolve(repoRoot, 'config/root-allowlist.lock.json');
  if (existsSync(rootLockPath)) {
    const lock = JSON.parse(readFileSync(rootLockPath, 'utf8'));
    const directories = {};
    for (const [name, entry] of Object.entries(lock.entries || {})) {
      if (entry.type === 'dir') directories[`${name}/`] = { purpose: entry.purpose };
    }
    return { directories };
  }
  return { directories: {} };
}

export function ontologyHomeFor(path, ontology = loadOntology()) {
  const first = String(path || '').split('/').filter(Boolean)[0];
  const key = first ? `${first}/` : '';
  const entry = ontology.directories?.[key];
  return entry ? `${key}: ${entry.purpose}` : 'unknown';
}

export function classifyItem(path, content = '') {
  const normalized = String(path || '').replace(/\\/g, '/');
  if (/\/reports\//i.test(normalized) || /\/REPORTS\.md$/i.test(normalized)) return 'report';
  if (/\/research\//i.test(normalized)) return 'research';
  const ext = extname(path).toLowerCase();
  if (['.csv', '.tsv', '.xlsx', '.xls', '.json'].includes(ext)) return 'dataset';
  if (['.db', '.sqlite', '.sqlite3'].includes(ext)) return 'database';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf'].includes(ext)) return 'rendering';
  if (ext === '.html') return 'visualization';
  const probe = `${path}\n${content.slice(0, 8192)}`;
  for (const [kind, pattern] of KIND_PATTERNS) {
    if (pattern.test(probe)) return kind;
  }
  if (['.md', '.txt'].includes(ext)) return 'note';
  if (['.js', '.mjs', '.css', '.sql'].includes(ext)) return 'source_file';
  return 'source_file';
}

export function contentStatus(path, content = '') {
  const text = `${path}\n${content}`.toLowerCase();
  if (text.includes('unresolved') || text.includes('open question')) return 'unresolved';
  if (text.includes('stale') || text.includes('superseded')) return 'stale';
  if (text.includes('promoted')) return 'promoted';
  return 'current';
}

export function readTextPrefix(absPath, maxBytes = 32768) {
  const ext = extname(absPath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext)) return '';
  const buf = readFileSync(absPath);
  return buf.subarray(0, maxBytes).toString('utf8');
}

export function scanWorkbenchRoot(rootPath, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const absRoot = resolveRepoPath(rootPath, repoRoot);
  if (!existsSync(absRoot)) return [];
  const items = [];

  function walk(absPath) {
    const st = lstatSync(absPath);
    if (st.isDirectory()) {
      const base = basename(absPath);
      if (base === 'node_modules' || base === '.git') return;
      for (const child of readdirSync(absPath)) walk(join(absPath, child));
      return;
    }
    if (!st.isFile()) return;
    if (st.size > (options.maxBytes || 2_000_000)) return;
    const path = toRepoPath(absPath, repoRoot);
    let content = '';
    try { content = readTextPrefix(absPath); } catch { content = ''; }
    const kind = classifyItem(path, content);
    const status = contentStatus(path, content);
    items.push({
      id: `wbi_${stableId(rootPath, path)}`,
      kind,
      path,
      title: basename(path),
      content_hash: sha256(content || `${path}:${st.size}:${st.mtimeMs}`),
      status,
      staleness: status === 'stale' ? 'stale' : 'current',
      metadata: {
        size: st.size,
        extension: extname(path).toLowerCase(),
        mtime_ms: Math.round(st.mtimeMs),
      },
      content,
    });
  }

  walk(absRoot);
  return items;
}

export function parseResumeIndex(markdown = '') {
  const out = {
    current_question: '',
    latest_state: '',
    next_action: '',
    distillation_contract: [],
    open_decisions: [],
    unresolved_questions: [],
    related_entities: [],
    canonical_promotion_targets: [],
    minimum_boot: [],
    deep_links: [],
  };
  let section = '';
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = line.match(/^##+\s+(.+)$/);
    if (heading) {
      section = heading[1].toLowerCase();
      continue;
    }
    if (!line) continue;
    const value = line.replace(/^[-*]\s*/, '').trim();
    if (!value) continue;
    if (section.includes('current question')) out.current_question ||= value;
    else if (section.includes('latest state')) out.latest_state ||= value;
    else if (section.includes('next action')) out.next_action ||= value;
    else if (section.includes('distillation contract')) out.distillation_contract.push(parseContractLine(value));
    else if (section.includes('open decision')) out.open_decisions.push(value);
    else if (section.includes('unresolved')) out.unresolved_questions.push(value);
    else if (section.includes('related entit')) out.related_entities.push(value);
    else if (section.includes('promotion')) out.canonical_promotion_targets.push(value);
    else if (section.includes('minimum boot')) out.minimum_boot.push(value);
    else if (section.includes('deep link')) out.deep_links.push(value);
  }
  return out;
}

function parseContractLine(value) {
  const match = String(value || '').match(/^([^:]{2,40}):\s*(.+)$/);
  if (!match) return value;
  return { key: match[1].trim().toLowerCase().replace(/\s+/g, '_'), label: match[1].trim(), value: match[2].trim() };
}

export function writeResumeIndex(path, payload, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const absPath = resolveRepoPath(path, repoRoot);
  mkdirSync(dirname(absPath), { recursive: true });
  const lines = [
    `# ${payload.title || payload.workbench_id || 'Workbench'}`,
    '',
    '## Current Question',
    payload.current_question || 'Continue the workbench from the latest state.',
    '',
    '## Latest State',
    payload.latest_state || payload.summary || 'Registered workbench substrate is ready to resume.',
    '',
    '## Next Action',
    payload.next_action || 'Resolve the workbench and inspect indexed substrate.',
    '',
    '## Now',
    payload.now || payload.current_question || 'Continue the current workbench thread.',
    '',
    '## Next',
    ...(payload.next?.length ? payload.next.map(x => `- ${x}`) : [`- ${payload.next_action || 'Resolve the workbench and inspect indexed substrate.'}`]),
    '',
    '## Waiting',
    ...(payload.waiting?.length ? payload.waiting.map(x => `- ${x}`) : ['- None recorded.']),
    '',
    '## Done Recently',
    ...(payload.done_recently?.length ? payload.done_recently.map(x => `- ${x}`) : ['- None recorded.']),
    '',
    '## Open Loops',
    ...(payload.open_loops?.length ? payload.open_loops.map(x => `- ${x}`) : ['- None recorded.']),
    '',
    '## Distillation Contract',
    ...formatDistillationContract(payload),
    '',
    '## Open Decisions',
    ...(payload.open_decisions?.length ? payload.open_decisions.map(x => `- ${x}`) : ['- None recorded.']),
    '',
    '## Unresolved Questions',
    ...(payload.unresolved_questions?.length ? payload.unresolved_questions.map(x => `- ${x}`) : ['- None recorded.']),
    '',
    '## Related Entities',
    ...(payload.related_entities?.length ? payload.related_entities.map(x => `- ${formatTarget(x)}`) : ['- None recorded.']),
    '',
    '## Canonical Promotion Targets',
    ...(payload.canonical_promotion_targets?.length ? payload.canonical_promotion_targets.map(x => `- ${formatTarget(x)}`) : ['- Primary attachment.']),
    '',
    '## Minimum Boot',
    ...(payload.minimum_boot?.length ? payload.minimum_boot.map(x => `- ${x}`) : ['- This INDEX.md']),
    '',
    '## Deep Links',
    ...(payload.deep_links?.length ? payload.deep_links.map(x => `- ${x}`) : ['- Root substrate directory']),
    '',
  ];
  writeFileSync(absPath, `${lines.join('\n')}\n`);
  return toRepoPath(absPath, repoRoot);
}

export function defaultDistillationContract(payload = {}) {
  const targets = payload.canonical_promotion_targets?.length
    ? payload.canonical_promotion_targets.map(formatTarget).join(', ')
    : 'Primary topic/entity context.md';
  return [
    { label: 'Purpose', value: payload.current_question || payload.summary || 'Make deep work resumable without rehydration.' },
    { label: 'Canonical target', value: targets },
    { label: 'Compact context', value: 'Promote only durable, reviewed conclusions into the attached context.md files.' },
    { label: 'Long synthesis', value: 'Keep deep, uncapped synthesis inside this workbench.' },
    { label: 'RAG substrate', value: 'Index source notes, datasets, renderings, histories, todos, and decisions from the workbench and cited source roots.' },
    { label: 'Review threshold', value: 'Working notes and substrate can be updated directly; canonical promotions require explicit reviewed compact wording.' },
  ];
}

export function formatDistillationContract(payload = {}) {
  const contract = payload.distillation_contract?.length ? payload.distillation_contract : defaultDistillationContract(payload);
  return contract.map((entry) => {
    if (typeof entry === 'string') return `- ${entry}`;
    return `- ${entry.label || entry.key || 'Rule'}: ${entry.value || ''}`;
  });
}

function formatTarget(target) {
  if (typeof target === 'string') return target;
  if (!target.type && !target.target_type && target.label) return target.label;
  return `${target.type || target.target_type}:${target.id || target.target_id}${target.role ? ` (${target.role})` : ''}`;
}

function defaultScanRoots(repoRoot) {
  return [
    `${USER_WORKBENCHES_REL}/topics/work/robot-dojo/wk_robot_dojo/stories`,
    USER_WORKBENCHES_REL,
    `${USER_CONTEXTS_REL}/research`,
    `${USER_CONTEXTS_REL}/topics`,
    `${USER_CONTEXTS_REL}/people`,
    `${USER_CONTEXTS_REL}/companies`,
    `${USER_CONTEXTS_REL}/places`,
    'docs',
    USER_FILES_REL,
    `${USER_DATABASES_REL}/health`,
    `${USER_TRANSCRIPTS_REL}/chat`,
    `${USER_TRANSCRIPTS_REL}/calls`,
  ].filter(path => existsSync(resolve(repoRoot, path)));
}

function discoverFiles(root, repoRoot, options, files = []) {
  if (!existsSync(root)) return files;
  const st = lstatSync(root);
  if (st.isDirectory()) {
    const base = basename(root);
    if (base === 'node_modules' || base === '.git') return files;
    const repoPath = toRepoPath(root, repoRoot);
    if (repoPath.includes('/workbench-discovery') || repoPath.includes('/discovery-output')) return files;
    if (new RegExp(`^${USER_CONTEXTS_REL.replace(/\//g, '\\/')}\\/topics\\/.+\\/framings(\\/|$)`).test(repoPath)) return files;
    const children = readdirSync(root);
    for (const child of children) {
      if (files.length >= (options.maxFiles || 5000)) break;
      discoverFiles(join(root, child), repoRoot, options, files);
    }
    return files;
  }
  if (!st.isFile()) return files;
  if (st.size > (options.maxBytes || 2_000_000)) return files;
  files.push(toRepoPath(root, repoRoot));
  return files;
}

export function seedForPath(path, options = {}) {
  const lower = path.toLowerCase();
  const seeds = activeDiscoverySeeds(options);
  for (const seed of seeds) {
    if (seed.paths.some(seedPath => lower.includes(seedPath.toLowerCase()))) return seed;
  }
  if (lower.includes('career') || lower.includes('deep-tech')) return seeds.find(s => s.key === 'career');
  if (lower.includes('health') || lower.includes('oura')) return seeds.find(s => s.key === 'health');
  if (lower.includes('coaching')) return seeds.find(s => s.key === 'coaching-deep-context');
  if (lower.includes('project-maple') || lower.includes('projectmaple')) return seeds.find(s => s.key === 'project-maple');
  if (lower.includes('robot-dojo') || lower.includes('robot dojo')) return seeds.find(s => s.key === 'robot-dojo');
  if (lower.includes('cedar')) return seeds.find(s => s.key === 'cedar');
  return null;
}

export function discoverWorkbenchCandidates(options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const ontology = loadOntology(repoRoot);
  const roots = options.roots || defaultScanRoots(repoRoot);
  const coveredPaths = new Set((options.coveredPaths || []).map(path => String(path).replace(/^\/+/, '')));
  const discovered = new Set();
  for (const root of roots) {
    discoverFiles(resolve(repoRoot, root), repoRoot, options).forEach(path => discovered.add(path));
  }

  const candidates = [];
  for (const path of [...discovered].sort()) {
    const abs = resolve(repoRoot, path);
    const ext = extname(path).toLowerCase();
    let content = '';
    try { content = readTextPrefix(abs, 16384); } catch { content = ''; }
    const kind = classifyItem(path, content);
    const seed = seedForPath(path, options);
    const workbenchSignals = [
      seed,
      SUPPORTED_ITEM_KINDS.has(kind) && kind !== 'source_file',
      /\b(research|dashboard|dossier|analysis|todo|next[-_ ]step|decision|history|status|view|chart|candidate|rfi|questionnaire)\b/i.test(path),
      /\b(next action|open question|decision|analysis|dashboard|resume|current state|latest state)\b/i.test(content),
      ['.csv', '.json', '.html', '.xlsx', '.xls', '.db', '.sqlite'].includes(ext),
    ].filter(Boolean).length;
    if (workbenchSignals < 2) continue;

    const confidence = seed ? Math.min(0.95, 0.45 + workbenchSignals * 0.12) : Math.min(0.82, 0.3 + workbenchSignals * 0.12);
    const classification = seed && confidence >= 0.7 ? 'clear' : confidence >= 0.65 ? 'ambiguous' : 'ignore';
    const target = seed?.target || inferTarget(path, content);
    const sourcePath = sourceRootForCandidate(path, seed);
    const covered = isCoveredByRegisteredWorkbench(path, sourcePath, coveredPaths);
    candidates.push({
      candidate_id: `wbc_${stableId(path, kind)}`,
      source_path: sourcePath,
      detected_shape: kind,
      current_ontology_home: ontologyHomeFor(path, ontology),
      recommended_target_type: target?.type || '',
      recommended_target_id: target?.id || '',
      confidence: Number(confidence.toFixed(2)),
      classification,
      reason: discoveryReason(path, kind, seed, workbenchSignals),
      required_owner_clarification: classification === 'ambiguous',
      recommended_action: covered ? 'registered' : classification === 'clear' ? 'register' : classification === 'ambiguous' ? 'link_only' : 'ignore',
      evidence_paths: [path],
      covered_evidence_paths: covered ? [path] : [],
      seed_key: seed?.key || '',
      ontology_violation: classification !== 'ignore' && !covered && !isCanonicalWorkbenchPath(path),
      resume_pointer_present: covered || /workbench|resume|next action|current state/i.test(content),
      coverage_status: covered ? 'registered' : 'unregistered',
    });
  }

  return coalesceCandidates(candidates);
}

function isCoveredByRegisteredWorkbench(path, sourcePath, coveredPaths) {
  if (!coveredPaths.size) return false;
  return pathSetIncludes(path, coveredPaths)
    || pathSetIncludes(sourcePath, coveredPaths)
    || [...coveredPaths].some(covered => sourcePath.startsWith(`${covered}/`));
}

function pathSetIncludes(path, coveredPaths) {
  if (!path) return false;
  if (coveredPaths.has(path)) return true;
  return [...coveredPaths].some(covered => path.startsWith(`${covered}/`));
}

function inferTarget(path, content) {
  const probe = `${path}\n${content}`.toLowerCase();
  if (probe.includes('airbnb')) return { type: 'company', id: 'airbnb' };
  if (/\bnar\b/.test(probe) || probe.includes('national association of realtors') || probe.includes('national association of realtors')) {
    return { type: 'company', id: 'national-association-of-realtors' };
  }
  if (probe.includes('project maple') || probe.includes('project-maple') || probe.includes('projectmaple')) return { type: 'topic', id: 'project-maple' };
  if (probe.includes('robot dojo') || probe.includes('robot-dojo')) return { type: 'topic', id: 'robot-dojo' };
  if (probe.includes('cedar')) return { type: 'topic', id: 'cedar' };
  if (probe.includes('blockchain') || probe.includes('crypto')) return { type: 'topic', id: 'technology' };
  if (probe.includes('property-search') || probe.includes('real estate')) return { type: 'topic', id: 'property-search' };
  if (probe.includes('health') || probe.includes('oura')) return { type: 'topic', id: 'health' };
  if (probe.includes('career') || probe.includes('deep-tech')) return { type: 'topic', id: 'career' };
  if (probe.includes('coaching')) return { type: 'topic', id: 'coaching' };
  return null;
}

function sourceRootForCandidate(path, seed) {
  if (seed) {
    const match = seed.paths
      .filter(seedPath => path.toLowerCase().includes(seedPath.toLowerCase()))
      .sort((a, b) => b.length - a.length)[0];
    if (match && !match.endsWith('-')) return match;
  }
  const parts = path.split('/');
  if (parts[0] === 'docs' && parts[1] && parts[2]) return parts.slice(0, 3).join('/');
  if (path.startsWith(`${USER_CONTEXTS_REL}/research/`)) return path;
  return path;
}

function discoveryReason(path, kind, seed, signals) {
  const bits = [`${kind} substrate`, `${signals} workbench signal(s)`];
  if (seed) bits.push(`matches ${seed.key} seed`);
  if (!isCanonicalWorkbenchPath(path)) bits.push('outside owning topic/entity workbench path');
  return bits.join('; ');
}

export function isCanonicalWorkbenchPath(path) {
  const value = String(path || '').replace(/^\/+/, '');
  return new RegExp(`^${USER_WORKBENCHES_REL.replace(/\//g, '\\/')}\\/topics\\/.+\\/[^/]+(?:\\/|$)`).test(value)
    || new RegExp(`^${USER_WORKBENCHES_REL.replace(/\//g, '\\/')}\\/entities\\/(people|companies|places)\\/[^/]+\\/[^/]+(?:\\/|$)`).test(value);
}

function coalesceCandidates(candidates) {
  const byRoot = new Map();
  for (const candidate of candidates) {
    const existing = byRoot.get(candidate.source_path);
    if (!existing) {
      byRoot.set(candidate.source_path, candidate);
      continue;
    }
    existing.evidence_paths.push(...candidate.evidence_paths);
    existing.covered_evidence_paths.push(...candidate.covered_evidence_paths);
    existing.confidence = Math.max(existing.confidence, candidate.confidence);
    if (existing.classification !== 'clear' && candidate.classification === 'clear') existing.classification = 'clear';
    if (!existing.seed_key && candidate.seed_key) existing.seed_key = candidate.seed_key;
    if (!existing.recommended_target_type && candidate.recommended_target_type) {
      existing.recommended_target_type = candidate.recommended_target_type;
      existing.recommended_target_id = candidate.recommended_target_id;
    }
    existing.coverage_status = coalescedCoverageStatus(existing.evidence_paths, existing.covered_evidence_paths);
    existing.required_owner_clarification = existing.classification === 'ambiguous' && existing.coverage_status !== 'registered';
    existing.recommended_action = recommendedDiscoveryAction(existing);
    existing.ontology_violation = existing.classification !== 'ignore'
      && existing.coverage_status !== 'registered'
      && !isCanonicalWorkbenchPath(existing.source_path);
    existing.resume_pointer_present = existing.resume_pointer_present || existing.coverage_status === 'registered';
  }
  return [...byRoot.values()].map(candidate => {
    const coverageStatus = coalescedCoverageStatus(candidate.evidence_paths, candidate.covered_evidence_paths);
    const recommendedAction = recommendedDiscoveryAction({ ...candidate, coverage_status: coverageStatus });
    return {
      ...candidate,
      evidence_paths: [...new Set(candidate.evidence_paths)].slice(0, 12),
      covered_evidence_paths: [...new Set(candidate.covered_evidence_paths)].slice(0, 12),
      coverage_status: coverageStatus,
      required_owner_clarification: candidate.classification === 'ambiguous' && coverageStatus !== 'registered',
      recommended_action: recommendedAction,
      ontology_violation: candidate.classification !== 'ignore'
        && coverageStatus !== 'registered'
        && !isCanonicalWorkbenchPath(candidate.source_path),
      resume_pointer_present: candidate.resume_pointer_present || coverageStatus === 'registered',
    };
  }).sort((a, b) => b.confidence - a.confidence || a.source_path.localeCompare(b.source_path));
}

function coalescedCoverageStatus(evidencePaths = [], coveredEvidencePaths = []) {
  const evidence = new Set(evidencePaths);
  const covered = new Set(coveredEvidencePaths);
  if (!evidence.size || !covered.size) return 'unregistered';
  return [...evidence].every(path => covered.has(path)) ? 'registered' : 'partial';
}

function recommendedDiscoveryAction(candidate) {
  if (candidate.coverage_status === 'registered') return 'registered';
  if (candidate.classification === 'clear') return 'register';
  if (candidate.classification === 'ambiguous') return 'link_only';
  return 'ignore';
}

export function validateDiscovery(candidates, options = {}) {
  const errors = [];
  if (options.strictSeeds) {
    for (const seed of activeDiscoverySeeds(options)) {
      const hit = candidates.some(candidate => candidate.seed_key === seed.key);
      if (!hit) errors.push(`missing seed hit: ${seed.key}`);
    }
  }
  if (options.failOnUnresolvedHighConfidence) {
    for (const candidate of candidates) {
      if (candidate.confidence >= 0.75 && candidate.ontology_violation) {
        const accounted = candidate.recommended_action === 'registered' || candidate.required_owner_clarification;
        if (!accounted) errors.push(`unaccounted high-confidence candidate: ${candidate.source_path}`);
      }
    }
  }
  if (options.failOnUnregisteredClear) {
    for (const candidate of candidates) {
      if (candidate.classification === 'clear' && candidate.recommended_action === 'register') {
        errors.push(`unregistered clear candidate: ${candidate.source_path}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function writeDiscoveryOutputs(candidates, options = {}) {
  const repoRoot = options.repoRoot || REPO_ROOT;
  const outDir = options.outDir || `${USER_WORKBENCHES_REL}/discovery-output`;
  const absOut = resolve(repoRoot, outDir);
  mkdirSync(absOut, { recursive: true });
  const manifestPath = join(absOut, 'manifest.json');
  const clarificationPath = join(absOut, 'clarifications.md');
  const payload = {
    generated_at: new Date().toISOString(),
    candidates,
    registration_set: candidates.filter(c => c.classification === 'clear' && c.recommended_action === 'register'),
    registered_set: candidates.filter(c => c.recommended_action === 'registered'),
    clarification_report: candidates.filter(c => c.required_owner_clarification),
  };
  writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(clarificationPath, renderClarificationReport(payload));
  return {
    manifest_path: toRepoPath(manifestPath, repoRoot),
    clarification_path: toRepoPath(clarificationPath, repoRoot),
  };
}

function renderClarificationReport(payload) {
  const lines = [
    '# Workbench Clarification Report',
    '',
    `Generated: ${payload.generated_at}`,
    '',
    '## Ambiguous Candidates',
    '',
  ];
  if (!payload.clarification_report.length) {
    lines.push('None.');
  } else {
    for (const c of payload.clarification_report) {
      lines.push(`- ${c.source_path} — ${c.reason}`);
    }
  }
  lines.push('', '## Clear Registrations', '');
  for (const c of payload.registration_set) {
    lines.push(`- ${c.source_path} → ${targetLabel(c)}`);
  }
  lines.push('', '## Already Registered', '');
  if (!payload.registered_set.length) {
    lines.push('None.');
  } else {
    for (const c of payload.registered_set) {
      lines.push(`- ${c.source_path} → ${targetLabel(c)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function targetLabel(candidate) {
  if (candidate.recommended_target_type && candidate.recommended_target_id) {
    return `${candidate.recommended_target_type}:${candidate.recommended_target_id}`;
  }
  return 'covered by registered workbench';
}

export function pathExists(path, repoRoot = REPO_ROOT) {
  return existsSync(resolve(repoRoot, path));
}

export function newestMtime(paths, repoRoot = REPO_ROOT) {
  let latest = 0;
  for (const path of paths) {
    try {
      latest = Math.max(latest, statSync(resolve(repoRoot, path)).mtimeMs);
    } catch {
      // Missing optional deep links are resolved by caller validation.
    }
  }
  return latest ? new Date(latest).toISOString() : null;
}
