import { indexWorkbench } from './workbench-rag.js';
import { appendMemoryEvent } from './memory-events.js';
import {
  formatTopicResumeBlock,
  subjectKey,
} from './topic-live-thread.js';
import {
  ensureWorkbenchMemoryFiles,
  fixtureForTarget,
  getWorkbench,
  registerWorkbench,
  resolveWorkbench,
  validateResumePayload,
} from './workbenches.js';

function resumeSubjectKey(payload) {
  const atts = payload?.attachments || [];
  const primary = atts.find((row) => (row.role || 'primary') === 'primary') || atts[0];
  if (!primary?.target_type || !primary?.target_id) return '';
  return subjectKey(primary.target_type, primary.target_id);
}

// Resolver errors the open path is allowed to recover from by self-registering
// a workbench for the requested target. "no registered workbench found" and
// "no topic or supported entity matched" are the two structurally-safe cases:
// no workbench exists yet AND the target either matches nothing or matches
// exactly one resolvable thing. Ambiguous errors are NOT in this set —
// resolveWorkbench is responsible for picking the right candidate before it
// gives up, not the open path. This boundary keeps the catch from silently
// auto-registering a wrong workbench when the target is genuinely ambiguous.
const RESOLVER_RECOVERABLE = /no registered workbench found|no topic or supported entity matched/i;

// "ambiguous entity target" can still happen in legacy DBs that pre-date the
// resolveCandidateTargets exact-topic preference fix (a stale snapshot whose
// user_topics row was deleted but whose fuzzy entity rows still trip the
// ambiguity check). In that case we ONLY recover when fixtureForTarget knows
// how to register the requested target — that is the safe, deliberate path.
const AMBIGUOUS_ENTITY = /ambiguous entity target/i;

function attachmentLinks(attachments = []) {
  return (attachments || [])
    .filter((attachment) => attachment?.target_type && attachment?.target_id)
    .map((attachment) => ({
      targetType: attachment.target_type,
      targetId: attachment.target_id,
      role: attachment.role || 'attachment',
    }));
}

export function openWorkbench(db, args = {}, options = {}) {
  const target = args.target || args.query || args._?.[0];
  const repoRoot = options.repoRoot;
  const maxFiles = Number(args.maxFiles || args['max-files'] || options.maxFiles || 2500);
  const skipEmbed = Boolean(args.skipEmbed || args['skip-embed']);
  const dryRun = Boolean(args.dryRun || args['dry-run'] || options.dryRun);

  if (!args.id && !target) throw new Error('workbench target or id required');

  let created = false;
  let workbench = args.id ? getWorkbench(db, args.id) : null;

  if (!workbench && target) {
    try {
      const existing = resolveWorkbench(db, { target, query: args.query }, { repoRoot });
      workbench = getWorkbench(db, existing.workbench_id);
    } catch (error) {
      const recoverable = RESOLVER_RECOVERABLE.test(error.message)
        || (AMBIGUOUS_ENTITY.test(error.message) && fixtureForTarget(target, { repoRoot }) != null);
      if (!recoverable) throw error;
      const registered = registerWorkbench(db, { target, id: args.id }, { repoRoot, maxFiles, dryRun });
      workbench = dryRun ? registered.workbench : getWorkbench(db, registered.id);
      created = true;
    }
  }

  if (workbench?.root_path) {
    ensureWorkbenchMemoryFiles(workbench.root_path, workbench, { repoRoot });
  }

  if (!workbench) {
    const registered = registerWorkbench(db, {
      id: args.id,
      target,
      slug: args.slug,
      title: args.title,
      root_path: args.root || args.rootPath,
    }, { repoRoot, maxFiles, dryRun });
    workbench = dryRun ? registered.workbench : getWorkbench(db, registered.id);
    created = true;
  }

  const indexed = indexWorkbench(db, workbench.id, { repoRoot, dryRun, skipEmbed });
  const payload = resolveWorkbench(db, { id: workbench.id }, { repoRoot });
  const resumeKey = resumeSubjectKey(payload);
  if (resumeKey) payload.resume_block = formatTopicResumeBlock(db, resumeKey);
  const validation = validateResumePayload(payload);
  const errors = [...validation.missing.map(field => `missing resume field: ${field}`)];

  if (!payload.deep_links?.length) errors.push('deep_links required');
  if (!payload.minimum_boot?.length) errors.push('minimum_boot required');
  if (!payload.canonical_promotion_targets?.length) errors.push('canonical promotion target required');
  if (!indexed.items && !indexed.chunks) errors.push('no indexed substrate');

  if (!dryRun) {
    const validAt = new Date().toISOString();
    appendMemoryEvent(db, {
      streamType: 'workbench',
      streamId: workbench.id,
      eventType: 'workbench.opened',
      actor: 'workbench-open',
      source: 'workbench:open',
      subjectType: 'workbench',
      subjectId: workbench.id,
      validAt,
      idempotencyKey: `workbench-open:${workbench.id}:${validAt}`,
      payload: {
        created,
        ok: errors.length === 0,
        root: payload.root,
        latest_state_chars: String(payload.latest_state || '').length,
        next_action_chars: String(payload.next_action || '').length,
        indexed_items: indexed.items || 0,
        indexed_chunks: indexed.chunks || 0,
      },
      links: attachmentLinks(payload.attachments),
    });
  }

  return {
    ok: errors.length === 0,
    created,
    errors,
    indexed,
    payload,
    contract: {
      command: `node scripts/workbench-open.js --target "${target || workbench.id}"`,
      create_or_resolve: true,
      registers_resume_index: true,
      indexes_for_rag: !skipEmbed,
      distillation_prompt: [
        'Confirm or revise this workbench distillation contract before major research/build work.',
        'Name the purpose, canonical target, compact-context rule, long-synthesis home, RAG substrate, and review threshold.',
      ].join(' '),
      distillation_contract: payload.distillation_contract,
      requires_promotion_to_canonical_context: true,
    },
  };
}
