/**
 * Thin Resend REST wrapper — transactional email via native fetch.
 *
 * No SDK. Resend's API is a single POST with a small JSON body.
 *   https://resend.com/docs/api-reference/emails/send-email
 *
 * Secrets
 *   RESEND_API_KEY     required (macOS keychain: robotdojo-RESEND_API_KEY)
 *   APP_BASE_URL       used in templates (defaults to https://robotdojo.ai)
 *
 * Sender
 *   hello@robotdojo.ai — requires DNS / domain verification in Resend.
 *   Until the domain is verified, Resend will error with a clear message.
 */

import config from './config.js';

// ── Newsletter / transactional detection (shared across Gmail + Outlook) ────
//
// st_d142f701 AC20: extracted from lib/gmail-sync.js so the Microsoft sync
// path uses the same predicate. Original signal-set rationale from
// st_1027f38e is preserved verbatim below; the predicate now accepts a
// generic header-lookup function so both Gmail (array-of-{name,value} from
// Gmail's full payload), Outlook (array-of-{name,value} from Graph's
// internetMessageHeaders), and drop-folder (header-name-keyed object from
// the .eml parser) can share the same logic.
//
// WHY widened from List-Unsubscribe-only:
//   The original predicate caught the dominant newsletter class but missed
//   transactional mail (Auto-Submitted receipts, Precedence: bulk system
//   notifications, Feedback-ID feedback-loop mailers, X-Auto-Response-
//   Suppress no-reply machines, noreply@ sender local-parts). Widening
//   flips the is_newsletter flag on every signal class so the existing
//   chunk-worker SQL pre-filter `is_newsletter=0 AND list_unsubscribe IS NULL`
//   catches all junk classes uniformly.
//
// @param {(name: string) => string|null} headerLookup — case-insensitive
//   header getter. Returns the value or null/'' when absent.
// @param {string|null} listUnsub — already-extracted List-Unsubscribe value,
//   passed by callers that have it on hand (gmail-sync, outlook-sync).
// @param {string|null} senderEmail — already-lowercased sender address.
// @returns {boolean}
export function detectNewsletterFromLookup(headerLookup, listUnsub, senderEmail) {
  if (listUnsub) return true;
  if (headerLookup('List-Id')) return true;
  if (headerLookup('Feedback-ID')) return true;

  // RFC 3834: Auto-Submitted MAY be "no" (= human-authored) or any other
  // value indicating an automaton sent the message.
  const autoSub = headerLookup('Auto-Submitted');
  if (autoSub && String(autoSub).toLowerCase().trim() !== 'no') return true;

  // Precedence: bulk|list|junk indicates a mailing-list / bulk system message
  // per RFC 2076 de-facto usage.
  const precedence = headerLookup('Precedence');
  if (precedence && /^(bulk|list|junk)$/i.test(String(precedence).trim())) return true;

  // X-Auto-Response-Suppress signals an automated sender per Microsoft Exchange.
  const xAuto = headerLookup('X-Auto-Response-Suppress');
  if (xAuto && /\b(DR|AutoReply|All|NDR|OOF|RN)\b/i.test(String(xAuto))) return true;

  // Sender local-part: noreply / no-reply / donotreply / do-not-reply.
  if (senderEmail) {
    const at = senderEmail.lastIndexOf('@');
    const local = (at > 0 ? senderEmail.slice(0, at) : senderEmail).toLowerCase();
    if (/(noreply|no-reply|donotreply|do-not-reply)/.test(local)) return true;
  }

  return false;
}

/**
 * Convenience wrapper for the Graph `internetMessageHeaders` shape
 * (array of `{name, value}`). Used by lib/outlook-sync.js to gain parity
 * with the Gmail newsletter predicate at sync time.
 */
export function detectNewsletterFromGraphHeaders(headers, listUnsub, senderEmail) {
  const lookup = (name) => {
    if (!Array.isArray(headers)) return null;
    const found = headers.find(h => String(h?.name || '').toLowerCase() === name.toLowerCase());
    return found?.value || null;
  };
  return detectNewsletterFromLookup(lookup, listUnsub, senderEmail);
}

/**
 * Parse a comma-separated participant header (To/Cc/Bcc) into an array of
 * lowercased email addresses. Drops anything without an @.
 *
 * st_fd14cdd4: moved here from lib/gmail-sync.js (which re-exports it) so the
 * drop-folder import path can parse To/Cc without importing the Gmail module.
 *
 * Examples:
 *   '"John Doe" <john@example.com>, jane@example.com'
 *     → ['john@example.com', 'jane@example.com']
 *   'bare@example.com'
 *     → ['bare@example.com']
 *   '' / undefined
 *     → []
 *
 * WHY a hand-rolled splitter: RFC 5322 quoted-string addresses may contain
 * commas inside the display name. We tokenize on `,` but never split inside
 * `"..."`. A full RFC parser is overkill — provider headers are well-formed
 * in practice.
 *
 * Unit-tested in tests/email-participant-extract.test.js.
 */
export function parseAddressList(header) {
  if (!header) return [];
  const tokens = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === '"') { inQuote = !inQuote; cur += ch; continue; }
    if (ch === ',' && !inQuote) { tokens.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) tokens.push(cur);

  const out = [];
  for (const tok of tokens) {
    const m = tok.match(/<([^>]+)>/) || tok.match(/([^\s<>"]+@[^\s<>"]+)/);
    if (!m) continue;
    const addr = m[1].trim().toLowerCase();
    if (addr.includes('@')) out.push(addr);
  }
  return out;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM_ADDRESS = config.fromAddress;
const REPLY_TO = 'miyagi@robotdojo.ai';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Low-level send. Returns `{ id }` on success, throws on failure.
 */
export async function sendEmail({ to, subject, html, text, replyTo = REPLY_TO }) {
  const apiKey = config.resendApiKey;
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');
  if (!to || !subject || (!html && !text)) {
    throw new Error('sendEmail requires to, subject, and html or text');
  }

  const payload = {
    from: FROM_ADDRESS,
    to: Array.isArray(to) ? to : [to],
    subject,
    reply_to: replyTo,
  };
  if (html) payload.html = html;
  if (text) payload.text = text;

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); }
    catch { detail = await res.text().catch(() => ''); }
    throw new Error(`Resend send failed (${res.status}): ${detail}`);
  }

  return res.json();
}

/**
 * Magic-link template. 15-minute TTL messaging is baked in.
 */
/**
 * Code-based login email. Primary pattern going forward — no URL for
 * scanners to pre-fetch; user types the 6-digit code into the login
 * form. Cookie is set on a same-page POST response so no cross-page
 * cookie propagation fragility.
 */
export async function sendMagicCodeEmail(email, code, serverName) {
  const safeEmail = escapeHtml(email);
  const safeCode = escapeHtml(code);
  const safeServer = escapeHtml(serverName || '');

  const subject = `Robot Dojo code: ${code}`;

  const text = [
    'Your Robot Dojo sign-in code:',
    '',
    `  ${code}`,
    '',
    `Signing in as: ${email}`,
    serverName ? `Device: ${serverName}` : null,
    '',
    'Type this code into the sign-in page to continue.',
    'The code expires in 15 minutes and can only be used once.',
    '',
    'If you did not request this, you can ignore this email.',
    '',
    '— Robot Dojo',
  ].filter(Boolean).join('\n');

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fafcff;font-family:-apple-system,BlinkMacSystemFont,'Inter',Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafcff;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="520" cellpadding="0" cellspacing="0"
            style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:36px;">
            <tr>
              <td style="padding-bottom:16px;">
                <div style="font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#3b82f6;font-weight:600;">
                  Robot Dojo
                </div>
                <h1 style="margin:12px 0 0;font-size:22px;font-weight:600;color:#0f172a;">
                  Your sign-in code
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0 16px;color:#334155;font-size:15px;line-height:1.55;">
                Signing in as <strong>${safeEmail}</strong>${safeServer ? ` on <strong>${safeServer}</strong>` : ''}.
                Type this code into the sign-in page:
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:12px 0 28px;">
                <div style="display:inline-block;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:36px;font-weight:700;letter-spacing:0.18em;padding:18px 28px;border-radius:12px;background:#f1f5f9;color:#0f172a;">${safeCode}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0 0 8px;color:#64748b;font-size:13px;line-height:1.55;">
                The code expires in 15 minutes and can only be used once.
                If you did not request this, ignore this email.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return sendEmail({ to: email, subject, text, html });
}

export async function sendMagicLinkEmail(email, magicLinkUrl) {
  const safeUrl = escapeHtml(magicLinkUrl);
  const safeEmail = escapeHtml(email);

  // Extract the user's handle from the new-form URL:
  //   https://robotdojo.ai/<handle>/api/auth/verify
  // Also supports legacy subdomain form and /me/<slug>/ for backward compat.
  let userHandle = '';
  let userSlug = '';
  try {
    const parsed = new URL(magicLinkUrl);
    const subdomain = parsed.hostname.match(/^([a-z0-9-]+)\.robotdojo\.ai$/);
    if (subdomain) {
      // Legacy subdomain form — slug equals handle for old URLs
      userSlug = subdomain[1];
      userHandle = subdomain[1];
    } else {
      // New form: https://robotdojo.ai/<handle>/api/auth/...
      const newForm = parsed.pathname.match(/^\/([a-z0-9-]+)\/api\/auth\//);
      if (newForm) {
        userHandle = newForm[1];
      } else {
        const m = /\/me\/([^/]+)\//.exec(magicLinkUrl);
        if (m) { userSlug = m[1]; userHandle = m[1]; }
      }
    }
  } catch {}
  const safeDevice = escapeHtml(userHandle || userSlug);

  // Bookmark URL always uses the simple /chat path — the 4-segment
  // /<servername>/<handle>/chat form is not in the Vercel middleware matcher
  // and caused redirect loops on page refresh.
  const bookmarkUrl = 'https://robotdojo.ai/chat';

  const subject = 'Your Robot Dojo sign-in link';

  const text = [
    'Sign in to Robot Dojo',
    '',
    `Signing in as: ${email}`,
    safeDevice ? `Device: ${safeDevice}` : null,
    '',
    'Click the link below to continue:',
    magicLinkUrl,
    '',
    'This link expires in 15 minutes and can only be used once.',
    bookmarkUrl ? `You can bookmark ${bookmarkUrl} for quick access once you're signed in on this browser.` : null,
    '',
    'If you did not request this, you can ignore this email.',
    '',
    '— Robot Dojo',
  ].filter(Boolean).join('\n');

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#fafcff;font-family:-apple-system,BlinkMacSystemFont,'Inter',Segoe UI,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafcff;padding:40px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="520" cellpadding="0" cellspacing="0"
            style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:36px;">
            <tr>
              <td style="padding-bottom:16px;">
                <div style="font-size:13px;letter-spacing:0.12em;text-transform:uppercase;color:#3b82f6;font-weight:600;">
                  Robot Dojo
                </div>
                <h1 style="margin:12px 0 0;font-size:22px;font-weight:600;color:#0f172a;">
                  Your sign-in link
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0 16px;color:#334155;font-size:15px;line-height:1.55;">
                Click the button below to sign in as <strong>${safeEmail}</strong>${safeDevice ? ` on <strong>${safeDevice}</strong>` : ''}.
              </td>
            </tr>
            <tr>
              <td style="padding:12px 0 24px;">
                <a href="${safeUrl}"
                  style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;
                         font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px;">
                  Sign in to Robot Dojo
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 0 16px;color:#64748b;font-size:13px;line-height:1.5;">
                Or paste this link into your browser:<br>
                <a href="${safeUrl}" style="color:#3b82f6;word-break:break-all;">${safeUrl}</a>
              </td>
            </tr>
            <tr>
              <td style="padding-top:16px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;line-height:1.5;">
                This link expires in 15 minutes and can only be used once.
                If you did not request this, you can safely ignore this email.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return sendEmail({ to: email, subject, html, text });
}
