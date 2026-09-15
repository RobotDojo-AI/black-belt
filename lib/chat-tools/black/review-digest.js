/**
 * review-digest — Black Belt tools wrapping lib/review-digest.js (st_180aa017
 * AC-3). ON-DEMAND ONLY: when the owner explicitly asks to review/clean up the
 * contacts the system is unsure about, these tools surface a few "maybe"
 * contacts (uncertain email classifications and borderline merge candidates) at
 * a time so the owner can clear them from chat in plain language, instead of the
 * CLI-only queues. The tools are never injected into the system prompt or a
 * per-turn nudge and must never be surfaced proactively — see the tool
 * descriptions' explicit "only when the owner asked this turn" guard.
 *
 * Registered Black Belt (not White) because resolving a merge-type maybe fuses
 * two people via the survivor-chain — a Black-Belt-class mutation
 * (merge_people is already Black). Registering White would let a White user
 * trigger a merge — a belt-escalation hole.
 */
import { defineTool, ok, err } from '../registry.js';
import dbSingleton from '../../db.js';
import { listReviewMaybes, resolveReviewMaybe } from '../../review-digest.js';

defineTool('list_review_maybes', {
  description: "List a few pending contacts the system is unsure about — uncertain email addresses and borderline merge candidates. Call this ONLY when the owner explicitly asks to review, see, or clean up the contacts you're unsure about (e.g. 'which contacts are you unsure about?', 'let's clean up my contacts'). Never call it proactively, never volunteer it mid-conversation, and never surface the queue unless the owner asked for it this turn. Black Belt feature.",
  belt: 'black',
  parameters: {
    properties: {
      limit: { type: 'integer', description: 'Max maybes to return (default 5)' },
    },
  },
  execute: async ({ limit } = {}, ctx) => {
    const db = ctx?.services?.db || dbSingleton;
    const maybes = listReviewMaybes(db, { limit: limit || 5 });
    return ok({ count: maybes.length, maybes });
  },
});

defineTool('resolve_review_maybe', {
  description: "Resolve one pending maybe the owner is actively reviewing (from a list_review_maybes the owner asked for): classify an uncertain email (person/role/junk) or decide a borderline merge (merge/separate/dismiss). Call only to carry out the owner's explicit decision on a specific maybe — never to volunteer or pre-resolve. A merge decision routes through the survivor-chain resolver so clearing one never orphans a fragment. Black Belt feature.",
  belt: 'black',
  parameters: {
    properties: {
      id: { type: 'integer', description: 'The maybe id from list_review_maybes' },
      kind: { type: 'string', enum: ['email', 'merge'], description: 'Which queue the id came from' },
      decision: { type: 'string', description: 'For kind:email — person|role|junk. For kind:merge — merge|separate|dismiss.' },
    },
    required: ['id', 'kind', 'decision'],
  },
  execute: async ({ id, kind, decision }, ctx) => {
    const db = ctx?.services?.db || dbSingleton;
    const res = resolveReviewMaybe(db, { id, kind, decision });
    return res.ok ? ok(res) : err(res.reason || 'resolution failed');
  },
});
