// Append a new version of an identity section to the hash-chained log.
// Latest-wins projection picks up the change on the next snapshot read.
// Old entries stay in the chain for audit — this is never destructive.
//
// The 5 default sections are TIMELESS (who you are, not what you're doing).
// Time-bounded content (current health state, active projects, career moves)
// belongs in topic contexts, not identity sections. The model should
// recognize this and refuse to store time-bounded content here.

import { defineTool, ok, err } from '../registry.js';
import { appendIdentitySection, DEFAULT_SECTIONS } from '../../identity-log.js';

defineTool('update_identity_section', {
  description: 'Update an identity card by appending a new version. Full body replacement, not a diff. Call read_identity_section first to see current state. IMPORTANT: the 5 default cards (identity, soul, philosophy, style, user) are TIMELESS — they describe who the user fundamentally IS, not what they are doing right now. Do not put health state, active projects, career moves, or any dated fact into these cards. Those go into topic contexts (use update_context). Custom sections can be created by passing any kebab-case name as `section`.',
  parameters: {
    properties: {
      section: {
        type: 'string',
        description: `Section slug. One of the 5 defaults (${DEFAULT_SECTIONS.join(', ')}) or any user-created kebab-case name.`,
      },
      body: {
        type: 'string',
        description: 'Full markdown body replacing the section. Be specific and concise. No top-level heading (the card title renders separately).',
      },
      description: {
        type: 'string',
        description: 'One-line description of what changed. Helps the user review their own history later.',
      },
    },
    required: ['section', 'body'],
  },
  async execute({ section, body, description }) {
    const slug = (section || '').toLowerCase().trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
      return err(`section must be kebab-case letters/digits: "${section}"`);
    }
    if (!body || !body.trim()) return err('body is required and cannot be empty');
    try {
      const res = await appendIdentitySection({
        section: slug,
        body: body.trim(),
        description: description || `Chat update to ${slug}`,
        author: 'chat',
      });
      return ok({ section: slug, sourceName: res.name, selfHash: res.selfHash });
    } catch (e) {
      return err(e.message);
    }
  },
});
