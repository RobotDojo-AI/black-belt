/**
 * GET /api/setup/permissions — macOS permission status for the Stage 2 card.
 *
 * Returns: { full_disk: bool, contacts: bool, calendar: bool, photos: bool, reminders: bool }
 *
 * The Stage 2 onboarding UI polls this every 2s; detection is automatic
 * (no "click here when done" button), so any permission grant in System
 * Settings flips the card within ~2s of the user clicking "Allow".
 *
 * Local-owner only. The probes touch user filesystem — refuse anonymous
 * callers even though most install-time hits originate from the loopback
 * app on :4338 with bearer auth.
 */

import { Hono } from 'hono';
import { effectiveUser } from './helpers.js';
import { detectPermissions } from '../../lib/macos-permissions.js';

const permissions = new Hono();

permissions.get('/permissions', (c) => {
  const user = effectiveUser(c);
  if (!user) return c.json({ error: 'unauthenticated' }, 401);

  // detectPermissions() never throws; on every failure path it returns
  // `false` for the affected key. Cached 1s by the lib to absorb 2-second
  // polling bursts even if multiple browser tabs are open.
  const perms = detectPermissions();
  return c.json(perms);
});

export default permissions;
