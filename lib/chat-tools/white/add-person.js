import db from '../../db.js';
import { defineTool, ok, err } from '../registry.js';
import { NEEDS_ROUTING_TOPIC } from '../../topic-routing-policy.js';
import { storeUserFact } from '../user-fact-store.js';

defineTool('add_person', {
  description: 'Add a person to the user\'s network. Always search_people first to avoid duplicates.',
  parameters: {
    properties: {
      name: { type: 'string', description: 'Full name' },
      email: { type: 'string', description: 'Email address' },
      phone: { type: 'string', description: 'Phone number' },
      company: { type: 'string', description: 'Company/org name' },
      title: { type: 'string', description: 'Job title' },
      relationship: { type: 'string', description: 'Relationship to user (sister, manager, friend, colleague, etc.)' },
      notes: { type: 'string', description: 'Any additional context' },
    },
    required: ['name'],
  },
  async execute({ name, email, phone, company, title, relationship, notes }) {
    const displayName = String(name || '').trim();
    if (!displayName) return err('Name is required.');

    const id = `person-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      db.prepare(`
        INSERT INTO people (id, display_name, notes, source_count, primary_source, confidence, created_at, updated_at)
        VALUES (?, ?, ?, 1, 'chat', 1.0, datetime('now'), datetime('now'))
      `).run(id, displayName, notes || null);
      db.prepare('UPDATE people SET needs_regen = 1 WHERE id = ?').run(id);

      if (email) {
        db.prepare('INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source, is_primary) VALUES (?, ?, ?, ?, 1)')
          .run(id, 'email', email, 'chat');
      }
      if (phone) {
        db.prepare('INSERT OR IGNORE INTO person_identifiers (person_id, type, value, source, is_primary) VALUES (?, ?, ?, ?, 0)')
          .run(id, 'phone', phone, 'chat');
      }
    } catch (e) {
      return err(`Failed to store person: ${e.message}`);
    }

    let relationshipFact = null;
    if (relationship) {
      relationshipFact = await storeUserFact({
        content: `${displayName} is my ${relationship}${company ? ` at ${company}` : ''}`,
        topic: NEEDS_ROUTING_TOPIC,
        sourceIdPrefix: `rel-${id}`,
        metadata: {
          source: 'chat',
          type: 'relationship',
          person_id: id,
          routing: 'uncategorized',
        },
      });
      if (!relationshipFact.ok) {
        return err(`Stored person but failed to store relationship fact: ${relationshipFact.error}`);
      }
    }

    return ok({
      id,
      name: displayName,
      relationship: relationship || null,
      relationship_fact_id: relationshipFact?.chunk_id || null,
      searchable: relationshipFact ? relationshipFact.searchable : true,
      degraded: relationshipFact ? !relationshipFact.searchable : false,
      reason: relationshipFact
        ? (relationshipFact.searchable ? 'embedded_now' : 'embedding_unavailable')
        : 'no_relationship_fact',
      embedding_error: relationshipFact?.searchable === false
        ? relationshipFact.embedding?.error || 'embedding_unavailable'
        : null,
      regen_pending: true,
    });
  },
});
