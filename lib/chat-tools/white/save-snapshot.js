import db from '../../db.js';
import { createSnapshot } from '../../snapshots.js';
import { defineTool, ok, err } from '../registry.js';

defineTool('save_snapshot', {
  description: 'Save a dated Snapshot: an official view, hypothesis, framework, decision, or analysis the user explicitly asks to preserve. ONLY call when the user asks to save, snapshot, memorialize, or mark an official view. Do not call autonomously; suggest a Snapshot in prose first when the user has not directed saving.',
  parameters: {
    properties: {
      topic_slug: { type: 'string', description: 'Topic slug to attach the Snapshot to. Preferred for topic work.' },
      scope_type: { type: 'string', description: 'Optional non-topic scope type, such as workbench, entity, or user.' },
      scope_id: { type: 'string', description: 'Optional non-topic scope id.' },
      title: { type: 'string', description: 'Short title for the Snapshot.' },
      body: { type: 'string', description: 'The durable official view, hypothesis, framework, decision, or analysis to save.' },
      snapshot_type: { type: 'string', description: 'view, hypothesis, framework, decision, relationship_read, thesis, or analysis.' },
      as_of: { type: 'string', description: 'Optional ISO timestamp if the Snapshot should be dated to a specific time.' },
      supersedes: { type: 'array', items: { type: 'string' }, description: 'Optional Snapshot ids this view supersedes.' },
      citations: { type: 'array', items: { type: 'string' }, description: 'Optional sources supporting the Snapshot.' },
    },
    required: ['title', 'body'],
  },
  async execute(args, ctx = {}) {
    const database = ctx.services?.db || db;
    const topic = String(args.topic_slug || '').trim();
    const scopeType = topic ? 'topic' : String(args.scope_type || '').trim();
    const scopeId = topic || String(args.scope_id || '').trim();
    if (!scopeType || !scopeId) return err('Snapshot scope required: pass topic_slug or scope_type plus scope_id.');
    try {
      const result = createSnapshot(database, {
        scopeType,
        scopeId,
        title: args.title,
        body: args.body,
        snapshotType: args.snapshot_type || 'view',
        validAt: args.as_of,
        inferred: false,
        sourceKind: 'user_countersigned',
        actor: 'chat',
        source: 'chat:save_snapshot',
        supersedes: args.supersedes || [],
        citations: (args.citations || []).map((source) => ({ source })),
      });
      return ok({
        snapshot_id: result.snapshot.snapshot_id,
        event_id: result.snapshot.event_id,
        inserted: result.inserted,
        scope_type: scopeType,
        scope_id: scopeId,
        valid_at: result.snapshot.valid_at,
        official: true,
      });
    } catch (e) {
      return err(e.message);
    }
  },
});
