/**
 * Compiled views — LLM-synthesized entity profiles. Black Belt only.
 * Results cached 24h per entity. Uses the compiled_views table (timeline_events_v1 schema)
 * extended with expires_at + model columns (compiled_views_ttl migration).
 * Cache invalidated on rebuild via DELETE or POST /invalidate.
 */
import { Hono } from 'hono';
import db from '../lib/db.js';
import config from '../lib/config.js';
// st_74f45a1a R2 — route Anthropic calls through the provider abstraction.
import { getProvider } from '../lib/llm/index.js';
import { ownerDisplayName } from '../lib/identity.js';
import {
  getCachedView,
  setCachedView,
  getPersonWithCompany,
  getRecentEmailsForPerson,
  getRecentMessagesForPerson,
  getCalendarEventsForPerson,
  invalidatePersonView,
  countAndInvalidateAllViews,
} from '../lib/compiled-queries.js';

const routes = new Hono();

const CACHE_TTL_HOURS = 24;

function gatherPersonSignals(personId) {
  const person = getPersonWithCompany(db, personId);
  if (!person) return null;

  const emailPattern = `%${person.email || 'NOMATCH'}%`;
  const recentEmails = getRecentEmailsForPerson(db, emailPattern, 8);
  const recentMessages = getRecentMessagesForPerson(db, personId, 10);
  const calendarEvents = getCalendarEventsForPerson(db, emailPattern, 5);

  return { person, recentEmails, recentMessages, calendarEvents };
}

function buildSynthesisPrompt(signals) {
  const { person, recentEmails, recentMessages, calendarEvents } = signals;
  const owner = ownerDisplayName();

  const parts = [
    `Write a concise 300-400 word relationship profile of ${person.display_name || person.name}.`,
    `This is for ${owner}'s personal reference — to quickly understand their relationship with this person.`,
    ``,
    `## What we know`,
    `Name: ${person.display_name || person.name}`,
    person.company_name ? `Company: ${person.company_name}` : '',
    person.class ? `Category: ${person.class}${person.subcategory ? ` / ${person.subcategory}` : ''}` : '',
    person.score ? `Relationship strength score: ${person.score}/100` : '',
    ``,
  ];

  if (recentEmails.length) {
    parts.push(`## Recent email interactions (last ${recentEmails.length})`);
    for (const e of recentEmails.slice(0, 4)) {
      parts.push(`- "${e.subject}" (${e.date?.slice(0, 10) || 'unknown date'})`);
    }
    parts.push('');
  }

  if (recentMessages.length) {
    parts.push(`## Recent iMessage snippets`);
    for (const m of recentMessages.slice(0, 5)) {
      const who = m.is_from_me ? owner : person.display_name?.split(' ')[0] || 'them';
      parts.push(`- ${who}: "${(m.text || '').slice(0, 100)}"`);
    }
    parts.push('');
  }

  if (calendarEvents.length) {
    parts.push(`## Shared calendar events`);
    for (const e of calendarEvents) {
      parts.push(`- ${e.title} (${e.start_date?.slice(0, 10) || 'unknown'})`);
    }
    parts.push('');
  }

  parts.push(`## Instructions`);
  parts.push(`Write a natural, useful profile. Cover: who they are, how they know ${owner}, the nature of the relationship (professional/personal/both), notable context, and anything worth remembering. No bullet lists in the output — write flowing prose. End with one sentence about the best way to continue the relationship.`);

  return parts.filter(Boolean).join('\n');
}

routes.get('/api/compiled/person/:id', async (c) => {
  const id = c.req.param('id');
  const belt = c.get('belt') || 'white';

  if (belt === 'white' || belt === 'demo') {
    return c.json({ error: 'belt_required' }, 403);
  }

  // Cache hit
  const cached = getCachedView(db, id);
  if (cached) return c.json({ content: cached.content, compiled_at: cached.compiled_at, stale: !!cached.stale, cached: true });

  // Gather signals
  const signals = gatherPersonSignals(id);
  if (!signals) return c.json({ error: 'not_found' }, 404);

  // Synthesize
  const prompt = buildSynthesisPrompt(signals);
  const model = config.models.compile;

  try {
    const provider = await getProvider('anthropic');
    const response = await provider.complete({
      model,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    const content = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const compiled_at = new Date().toISOString();
    setCachedView(db, id, content, model, CACHE_TTL_HOURS);
    return c.json({ content, compiled_at, stale: false, cached: false });
  } catch (err) {
    console.error('[compiled] synthesis failed:', err.message);
    return c.json({ error: 'synthesis_failed', message: err.message }, 500);
  }
});

// Invalidate compiled cache for a person (call after network rebuild)
routes.delete('/api/compiled/person/:id', (c) => {
  invalidatePersonView(db, c.req.param('id'));
  return c.json({ ok: true });
});

// Bulk invalidate (call after full rebuild)
routes.post('/api/compiled/invalidate', (c) => {
  const { count } = countAndInvalidateAllViews(db);
  return c.json({ ok: true, invalidated: count });
});
export default routes;
