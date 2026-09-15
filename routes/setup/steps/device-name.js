// Onboarding: confirm this Mac.
//
// Comes BEFORE api-key in the setup order. The product-facing name defaults
// to the Mac computer name. The user confirms the login slug here so remote
// login has a memorable name; the login token stays in Account → Remote Access.
//
// Completion means the user has accepted the Mac name or typed a clearer
// product-facing label plus login slug. It does not expose relay mechanics
// or login tokens.

import { execSync } from 'node:child_process';
import { readSetting } from '../helpers.js';
import { suggestFromHostname } from '../../../lib/device-rename.js';
import { validateSlug } from '../../../lib/reserved-slugs.js';
import db from '../../../lib/db.js';
import { getAdminUserSlug, getAdminUserHandle, setUserHandle } from '../../../lib/setup-queries.js';

function setOwnerHandle(slug) {
  try {
    // On initial setup, set user_handle = user_slug. User can change handle independently later.
    const row = getAdminUserHandle(db);
    if (row && !row.user_handle) {
      setUserHandle(db, slug, row.id);
    }
  } catch { /* non-fatal */ }
}

function hostname() {
  try { return execSync('hostname -s', { encoding: 'utf8', timeout: 500 }).trim(); }
  catch { return ''; }
}

function compute() {
  const slug = getAdminUserSlug(db);
  // The install flow mints a placeholder slug like `user-941eda0d`
  // for users that came up before this card existed. If the stored slug
  // still looks like that placeholder shape (email-prefix + hex suffix),
  // force the user to rename before the card is marked complete.
  const isPlaceholder = slug && /-[0-9a-f]{8,}$/i.test(slug);

  // Also require the user to have EXPLICITLY accepted — otherwise a user
  // who landed here with a legacy slug would never see the rename prompt.
  const acknowledged = readSetting('device_name_confirmed') === '1';

  const badShape = slug && !!validateSlug(slug);
  const complete = !!slug && !isPlaceholder && !badShape && acknowledged;

  const preview = !slug
    ? 'Confirm what this Mac should be called'
    : complete
      ? 'This Mac is named'
      : isPlaceholder
        ? 'Rename this Mac to something recognizable'
        : 'Confirm this Mac name';

  return { complete, preview };
}

export default {
  id: 'device-name',
  title: 'This Mac',
  description: 'Confirm this computer and its login name',
  icon: 'badge',
  compute,
  chat_context: 'device-name-setup',
  chat_prompt: `Help me pick a clear name for this Mac. The hostname is "${hostname()}". Prefer a human-readable computer name over infrastructure language. Once I've decided, help me save it as this Mac's display name.`,
  inline: false,
  category: 'core',
  hostname: hostname(),
  suggestion: suggestFromHostname(hostname()),
};
