/**
 * Google OAuth scopes — single source of truth.
 *
 * Routes/oauth.js builds the consent URL from this file, and the local setup
 * API exposes the same descriptions to Account Integrations. Displayed copy
 * always matches the actual scope grant exactly.
 *
 * Current Google scope list:
 *   - Gmail read + send + compose + labels + settings
 *   - Calendar (full CRUD)
 *   - Contacts (full CRUD)
 *   - Drive (read-only full history)
 *   - Docs / Sheets / Slides (full CRUD)
 *   - Photos (read-only metadata + media)
 *   - Search Console (read + write — sitemap auto-heal needs submit)
 *
 * st_5a63545d AC 9. Research source: st_5a63545d 01-research.md (in the wk_robot_dojo stories tree).
 */

export const SCOPES = [
  'email',
  'profile',
  'openid',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/gmail.settings.sharing',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  'https://www.googleapis.com/auth/photoslibrary.readonly',
  'https://www.googleapis.com/auth/webmasters',
];

/**
 * Map of scope URI → human-readable description for wizard copy.
 * Keys must match SCOPES exactly (AC 9 verification asserts
 * SCOPES.length === Object.keys(SCOPE_DESCRIPTIONS).length).
 */
export const SCOPE_DESCRIPTIONS = {
  'email':                                                        'Your Google email address (sign-in identity)',
  'profile':                                                      'Your Google profile (name, picture)',
  'openid':                                                       'OpenID sign-in token',
  'https://www.googleapis.com/auth/gmail.readonly':               'Read Gmail messages and threads',
  'https://www.googleapis.com/auth/gmail.send':                   'Send email on your behalf',
  'https://www.googleapis.com/auth/gmail.compose':                'Compose and save drafts',
  'https://www.googleapis.com/auth/gmail.labels':                 'Read and manage Gmail labels',
  'https://www.googleapis.com/auth/gmail.settings.basic':         'Read and update basic Gmail settings (signature, auto-reply)',
  'https://www.googleapis.com/auth/gmail.settings.sharing':       'Read and update sharing settings (forwarding, delegates)',
  'https://www.googleapis.com/auth/calendar':                     'Read and write to your Google Calendars',
  'https://www.googleapis.com/auth/contacts':                     'Read and write your Google Contacts',
  'https://www.googleapis.com/auth/drive.readonly':               'Read your Google Drive files for local indexing',
  'https://www.googleapis.com/auth/documents':                    'Read and write Google Docs',
  'https://www.googleapis.com/auth/spreadsheets':                 'Read and write Google Sheets',
  'https://www.googleapis.com/auth/presentations':                'Read and write Google Slides',
  'https://www.googleapis.com/auth/photoslibrary.readonly':       'Read Google Photos library metadata and media',
  'https://www.googleapis.com/auth/webmasters':                   'Read and submit Search Console data (sitemap auto-heal)',
};

/**
 * Build the wizard's scope-list copy from SCOPE_DESCRIPTIONS. Generated text,
 * not a hardcoded string — guarantees AC 9's drift-free contract.
 */
export function describeScopes() {
  return SCOPES.map((s) => SCOPE_DESCRIPTIONS[s]).filter(Boolean);
}

export const GOOGLE_DRIVE_FULL_HISTORY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
export const GOOGLE_PHOTOS_READONLY_SCOPE = 'https://www.googleapis.com/auth/photoslibrary.readonly';
