// lib/distill-sources/identity-log.js — pull the user's CURRENT identity
// cards as context for the LLM (so it knows what to supersede vs keep).

import { currentSnapshot } from '../identity-log.js';

export async function gather() {
  const snap = await currentSnapshot();
  const out = [];
  for (const section of snap.order) {
    const s = snap.sections[section];
    if (!s || !s.body) continue;
    out.push({
      source: `identity-log:${section}`,
      timestamp: s.updatedAt,
      type: 'identity-current',
      section,
      description: `Current ${section} card`,
      body: s.body,
      validCards: [section],
    });
  }
  return out;
}
