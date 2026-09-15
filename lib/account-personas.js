// lib/account-personas.js — shapes the six canonical agent personas into
// account-page card data. Thin facade over lib/agent-personas.js so the
// Accounts route stays HTTP plumbing.
//
// st_4e7e3aaf AC9 — the Agents page renders one block per persona in
// PERSONA_ORDER (Miyagi, Tantei, Hakase, Ori, Katagami, Bunshin), not the
// legacy root AGENTS.md blob. Each card carries displayName, kanji, role,
// description, model, tools, and the full body markdown so the frontend
// can render the eight canonical sections with marked.js + DOMPurify.

import { readAllPersonas } from './agent-personas.js';

function normalizeTools(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export function accountPersonaCards() {
  const personas = readAllPersonas();
  return personas.map((p) => ({
    id: `agent:${p.displayName.toLowerCase()}`,
    displayName: p.displayName,
    kanji: p.frontmatter?.kanji || '',
    role: p.frontmatter?.role || '',
    description: p.frontmatter?.description || '',
    path: `agents/personas/${p.displayName}.md`,
    model: p.frontmatter?.model || '',
    tools: normalizeTools(p.frontmatter?.tools),
    disallowedTools: normalizeTools(p.frontmatter?.disallowedTools),
    body: p.body || '',
  }));
}

export default accountPersonaCards;
