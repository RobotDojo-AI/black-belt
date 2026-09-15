/**
 * Chat tool: set_relation_tag — Miyagi manual override for a person's
 * family relation_tag. Story st_87a0d072 Phase 7.
 *
 * WHY a chat tool: users tell the assistant "tag Carol as my parent". The
 * tool turns that intent into a single DB write at confidence 1.0. The next
 * pipeline run (Phase 4 detectFamily + Phase 2 inferFamilyRelationships)
 * sees the existing tag and skips its own inference for that row, so manual
 * tags survive every rebuild.
 *
 * Calls lib/people-write.setRelationTag directly — no HTTP self-call. The
 * routes/people.js HTTP surface exists for the browser app; this tool is
 * the chat surface.
 */
import db from '../../db.js';
import { defineTool, ok, err } from '../registry.js';
import { setRelationTag } from '../../people-write.js';
import { FAMILY_TAGS } from '../../scoring.js';
import { RELATION_LABELS } from '../../relation-vocabulary.js';

defineTool('set_relation_tag', {
  description:
    'Set or change a person\'s family relation tag (parent, sibling, spouse, etc.), ' +
    'optionally with a gendered sub-label (mother, father, wife, …). ' +
    'Confidence 1.0 — overrides any automatic inference. Use search_people first to ' +
    'get the person_id.',
  parameters: {
    properties: {
      person_id: { type: 'string', description: 'Person ID (use search_people to find it).' },
      relation_tag: {
        type: 'string',
        description: `One of: ${Array.from(FAMILY_TAGS).join(', ')}`,
      },
      relation_label: {
        type: 'string',
        description: `Optional gendered/granular sub-label; must belong to relation_tag. One of: ${Object.keys(RELATION_LABELS).join(', ')}`,
      },
    },
    required: ['person_id', 'relation_tag'],
  },
  execute({ person_id, relation_tag, relation_label = null }) {
    try {
      // st_df0a8d71 — setRelationTag now owns the whole write: validation,
      // relation_label, the entity_facts supersede pair, needs_regen, and the
      // graph-change event. No second write here.
      const updated = setRelationTag(db, person_id, relation_tag, relation_label, { source: 'chat-tool' });
      if (!updated) return err(`Person ${person_id} not found`);
      return ok({
        person: {
          id: updated.id,
          display_name: updated.display_name,
          relation_tag: updated.relation_tag,
          relation_label: updated.relation_label || null,
        },
        regen_pending: true,
      });
    } catch (e) {
      return err(e.message);
    }
  },
});
