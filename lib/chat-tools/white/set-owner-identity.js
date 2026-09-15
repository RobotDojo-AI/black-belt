/**
 * Chat tool: set_owner_identity — the @miyagi update path for the OWNER's
 * canonical identity (df_cbd30a5a AC-4).
 *
 * Who "you" are is declared at install, and this tool is how the owner reviews
 * and updates it later without re-running the installer. The owner's declared
 * name + hard identifiers (emails / phones) are the protective set the
 * owner-anchor guard keys on (lib/people-merge.js), so keeping them current is
 * how the owner stays himself even as new addresses appear.
 *
 * ONE write path: this tool → writeDeclaredOwner → identity.json, the SAME
 * single writer the installer uses (no drift). After writing it re-anchors
 * owner_person_id (anchorDeclaredOwner) and re-derives the owner view
 * (refreshDerivedRelationCache + refreshEgoBlock) so the change is live next
 * turn. Tier-0 deterministic — no LLM writes a DB row.
 *
 * Merge semantics: unspecified fields keep their current declared value, so
 * "add my new work email" only appends, and "my name is X" only renames.
 * writeDeclaredOwner enforces the NOT-NULL analog (name + ≥1 valid email).
 */
import db from '../../db.js';
import { defineTool, ok, err } from '../registry.js';
import {
  readDeclaredOwner,
  writeDeclaredOwner,
  anchorDeclaredOwner,
} from '../../identity.js';
import { refreshDerivedRelationCache } from '../../people-write.js';
import { refreshEgoBlock } from '../../ego-render.js';

defineTool('set_owner_identity', {
  description:
    'Review or update the OWNER\'s canonical identity — the user\'s own name and hard identifiers '
    + '(emails and phone numbers) that define who "you" are. Use when the user says things like '
    + '"my name is …", "add my email …", "these are my email addresses", or "update my identity". '
    + 'Unspecified fields are left unchanged. This is the protected identity the assistant treats as '
    + 'the user; it can never be another person.',
  parameters: {
    properties: {
      name: { type: 'string', description: "The owner's canonical full name." },
      emails: {
        type: 'array',
        items: { type: 'string' },
        description: "The owner's full set of email addresses. REPLACES the current set — include existing ones to keep them.",
      },
      add_email: { type: 'string', description: 'Append a single email to the owner\'s current set (keeps the rest).' },
      phones: {
        type: 'array',
        items: { type: 'string' },
        description: "The owner's phone numbers. REPLACES the current set.",
      },
      owner_person_id: {
        type: 'string',
        description: 'Optional: point the owner anchor at a specific person record (use search_people to find it).',
      },
    },
  },
  async execute({ name, emails, add_email, phones, owner_person_id } = {}) {
    try {
      const current = readDeclaredOwner();

      const nextName = (name && String(name).trim()) || current.name;
      let nextEmails = Array.isArray(emails) && emails.length ? emails.slice() : current.emails.slice();
      if (add_email && String(add_email).trim()) nextEmails.push(String(add_email).trim());
      const nextPhones = Array.isArray(phones) ? phones.slice() : current.phones.slice();

      // Single writer — enforces name + ≥1 valid email, normalizes, resets cache.
      const written = writeDeclaredOwner({
        name: nextName,
        emails: nextEmails,
        phones: nextPhones,
        owner_person_id: owner_person_id || current.owner_person_id || null,
        declared_source: 'chat-update',
      });

      // Re-anchor owner_person_id from the (possibly changed) email set unless
      // the caller pinned one explicitly.
      let anchor = { owner_person_id: written.owner_person_id };
      if (!owner_person_id) {
        try { anchor = await anchorDeclaredOwner(db); } catch { /* anchor is best-effort */ }
      }

      // Re-derive the owner view so the change is live next turn.
      try { refreshDerivedRelationCache(db, { ownerId: anchor.owner_person_id || written.owner_person_id }); } catch { /* graph may be empty */ }
      try { refreshEgoBlock(db); } catch { /* ego block re-render is best-effort */ }

      return ok({
        declared: true,
        name: written.name,
        emails: written.emails,
        phones: written.phones,
        owner_person_id: anchor.owner_person_id || written.owner_person_id,
      });
    } catch (e) {
      return err(e.message);
    }
  },
});
