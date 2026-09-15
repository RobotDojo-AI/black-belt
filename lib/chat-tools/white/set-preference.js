import db from '../../db.js';
import { defineTool, ok, err } from '../registry.js';

const ALLOWED_KEYS = ['name', 'timezone', 'tone', 'system_prompt_extra', 'language', 'email', 'location', 'bio'];

const KEY_VALIDATORS = {
  tone: (v) => ['casual', 'professional', 'direct'].includes(v) ? null : 'tone must be casual, professional, or direct',
  timezone: (v) => {
    try { Intl.DateTimeFormat(undefined, { timeZone: v }); return null; }
    catch { return `invalid timezone: ${v}`; }
  },
  email: (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'invalid email address',
  name: (v) => v.trim().length > 0 ? null : 'name cannot be empty',
  system_prompt_extra: (v) => v.length <= 2000 ? null : 'system_prompt_extra must be ≤2000 characters',
  bio: (v) => v.length <= 1000 ? null : 'bio must be ≤1000 characters',
};

const upsert = db.prepare(
  "INSERT INTO user_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')"
);

defineTool('set_preference', {
  description: 'Set a single user preference. Keys: name, timezone, tone (casual/professional/direct), system_prompt_extra (see also update_soul), language, email, location, bio (freeform about-me). For multi-field profile updates prefer update_profile.',
  parameters: {
    properties: {
      key: { type: 'string', description: 'Preference key' },
      value: { type: 'string', description: 'Preference value' },
    },
    required: ['key', 'value'],
  },
  execute({ key, value }) {
    if (!ALLOWED_KEYS.includes(key)) return err(`Unknown preference: ${key}. Allowed: ${ALLOWED_KEYS.join(', ')}`);
    const validate = KEY_VALIDATORS[key];
    if (validate) {
      const msg = validate(String(value));
      if (msg) return err(msg);
    }
    upsert.run(key, String(value), String(value));
    return ok({ key, value });
  },
});
