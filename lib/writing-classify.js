/**
 * Deterministic writing classifier. No LLM.
 * Owner-draft when the turn is something he will send. Else Miyagi reply.
 * A named recipient ("for Jordan") is enough. Do not require "my voice."
 */

export const INTELLIGENCE_TIER = 'extraction';

const OWNER_CHANNEL = /\b(email|gmail|linkedin|sms|imessage|i-message|text message|draft|paste|memo|proposal)\b/i;
const OWNER_SEND = /\b(send this to|write to|draft for|note to|message to|reprint .{0,80} for)\b/i;
const FOR_NAME = /\bfor\s+[A-Z][\w'-]+/;

export function classifyWriting(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return { speaker: 'miyagi', ownerDraft: false, reason: 'empty' };
  }
  if (/^\s*\/write\b/i.test(raw)) {
    return { speaker: 'owner', ownerDraft: true, reason: 'slash_write' };
  }
  if (FOR_NAME.test(raw)) {
    return { speaker: 'owner', ownerDraft: true, reason: 'for_name' };
  }
  if (OWNER_SEND.test(raw)) {
    return { speaker: 'owner', ownerDraft: true, reason: 'send_framing' };
  }
  if (OWNER_CHANNEL.test(raw)) {
    return { speaker: 'owner', ownerDraft: true, reason: 'channel' };
  }
  return { speaker: 'miyagi', ownerDraft: false, reason: 'reply' };
}

export function inferOwnerSlugs(text) {
  const raw = String(text || '').toLowerCase();
  let formatting = null;
  if (/\bgmail\b/.test(raw)) formatting = 'gmail';
  else if (/\bemail\b/.test(raw)) formatting = 'email';
  else if (/\blinkedin\b/.test(raw)) formatting = 'linkedin';
  else if (/\b(sms|imessage|text message)\b/.test(raw)) formatting = 'sms';
  else if (/\basana\b/.test(raw)) formatting = 'asana';

  let structure = null;
  if (/\bmemo\b/.test(raw)) structure = 'memo';
  else if (/\bproposal\b/.test(raw)) structure = 'proposal';
  else if (/\bessay\b/.test(raw)) structure = 'essay';
  else if (/\bspeech\b/.test(raw)) structure = 'speech';

  return { structure, formatting };
}
