// Trigger a fresh identity distillation. Runs the corpus-miner over the
// user's memory log + identity state + robotdojo chat history + sent emails,
// produces proposed card bodies + topic contexts, returns them for review.
// Does NOT auto-apply — the user must approve each change by calling
// update_identity_section.

import { defineTool, ok, err } from '../registry.js';
import { distill, CARDS, TOPIC_SLUGS } from '../../identity-distill.js';

defineTool('distill_identity', {
  description: 'Run a fresh identity distillation against the user\'s accumulated corpus (memory log, prior chats, sent emails). Returns PROPOSED new card bodies (Identity/Soul/Philosophy/Style/User) + topic-context suggestions (health/career/projects/family/finances). The user reviews and applies changes via update_identity_section. Use when the user says "refresh my identity" or "what have you learned about me lately?".',
  parameters: {
    properties: {
      skip: {
        type: 'string',
        description: 'Comma-separated source names to exclude (e.g. "email,robotdojoChat"). Available: memoryLog, identityLog, robotdojoChat, email.',
      },
    },
    required: [],
  },
  async execute({ skip }) {
    const sources = {};
    if (skip) for (const s of skip.split(',').map((t) => t.trim()).filter(Boolean)) sources[s] = false;
    try {
      const res = await distill({ sources });
      const summary = {};
      for (const c of CARDS) {
        const body = res.cards[c.id] || '';
        summary[c.id] = { verb: c.verb, bytes: Buffer.byteLength(body, 'utf8'), preview: body.slice(0, 200) };
      }
      const topicSummary = {};
      for (const slug of TOPIC_SLUGS) {
        if (res.topics && res.topics[slug]) {
          const body = res.topics[slug];
          topicSummary[slug] = { bytes: Buffer.byteLength(body, 'utf8'), preview: body.slice(0, 200) };
        }
      }
      return ok({
        notes: res.notes,
        usage: res.usage,
        sources: res.bundles,
        cards: res.cards,
        cardSummary: summary,
        topics: res.topics || {},
        topicSummary,
        next: 'Review each proposed card. Call update_identity_section(section, body) for each change you want to keep. Topics go to update_context.',
      });
    } catch (e) {
      return err(e.message);
    }
  },
});
