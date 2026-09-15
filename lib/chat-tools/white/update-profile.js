import db from '../../db.js';
import { defineTool, ok, err } from '../registry.js';

/**
 * Update the user's profile — name, email, timezone, location, language,
 * tone, and a freeform `bio`. Writes each provided field to user_settings
 * in a single transaction. All fields optional; at least one must be given.
 *
 * Persona/behavior instructions ("how Miyagi should talk to me") do NOT live
 * here — use update_soul for that. This tool owns *user-about-user* facts.
 */
const PROFILE_FIELDS = ['name', 'email', 'timezone', 'location', 'language', 'tone', 'bio'];
const MAX_BIO = 8000;

defineTool('update_profile', {
  description: "Update one or more fields of the user's profile in a single call. For freeform self-description use the `bio` field. For persona/behavior rules use update_soul instead.",
  parameters: {
    properties: {
      name:     { type: 'string', description: "Display name (what Miyagi should call the user)." },
      email:    { type: 'string', description: 'Primary email.' },
      timezone: { type: 'string', description: 'IANA timezone, e.g. America/New_York.' },
      location: { type: 'string', description: 'City, region, or "City, State".' },
      language: { type: 'string', description: 'Preferred language (e.g. en, es).' },
      tone:     { type: 'string', description: 'casual | professional | direct — short label for preferred reply tone.' },
      bio:      { type: 'string', description: `Freeform self-description — who the user is, what they do, what matters. Max ${MAX_BIO} chars.` },
    },
    required: [],
  },
  execute(args) {
    const provided = {};
    for (const key of PROFILE_FIELDS) {
      if (args[key] != null && String(args[key]).length > 0) provided[key] = String(args[key]);
    }
    if (Object.keys(provided).length === 0) {
      return err('Pass at least one profile field: ' + PROFILE_FIELDS.join(', '));
    }
    if (provided.bio && provided.bio.length > MAX_BIO) {
      return err(`bio is ${provided.bio.length} chars, exceeds max ${MAX_BIO}.`);
    }

    const stmt = db.prepare(
      "INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
    );
    const tx = db.transaction((fields) => {
      for (const [k, v] of Object.entries(fields)) stmt.run(k, v, v);
    });
    tx(provided);

    return ok({ updated: Object.keys(provided), count: Object.keys(provided).length });
  },
});
