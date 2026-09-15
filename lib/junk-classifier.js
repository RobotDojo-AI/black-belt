/**
 * lib/junk-classifier.js
 *
 * Pure-function junk classifier for the RAG ingest pipeline.
 *
 * WHY pure function: this module is the single source of truth for whether a
 * given source row earns a vec embedding. It is called from chunk-worker.js
 * (LaunchAgent, every 120s) and drive-sync.js (script). To stay safely
 * callable from both, it touches NO db, NO filesystem, NO network — only its
 * input arguments. Compute Tier 0 per CLAUDE.md.
 *
 * WHY single classifier, multiple call sites: research (Tantei + Hakase)
 * showed two physical chunk pipelines (email/calendar/iMessage/transcript via
 * chunk-worker, drive via drive-sync). Different junk thresholds per source
 * would drift quickly. One classifier with a source_type switch keeps the
 * gate symmetric and auditable.
 *
 * Exports:
 *   classifyChunk({source_type, body, sender_email, subject, is_newsletter,
 *                  list_unsubscribe, headers})
 *     → { shouldEmbed: boolean, junkClass: string|null, strippedBody: string|null }
 *
 * Body-stripping order (inside email/drive path):
 *   1. HTML tag strip  — email bodies may have HTML fragments
 *   2. Quoted-reply    — email-reply-parser (crisp-oss, MIT)
 *   3. Footer regex    — boilerplate / legal / "sent from my" / dash sig
 *   4. Token-count check — whitespace-split count < 50 → 'short-body'
 *
 * iMessage carve-out (load-bearing):
 *   FIRST guard. iMessage chunks are read by scripts/extract-imessage/
 *   01-extract.js:278 for participant metadata. Purging them breaks that
 *   pipeline. Source_type='imessage' always passes through (shouldEmbed=true,
 *   junkClass=null, strippedBody=body).
 *
 * Junk classes returned (junkClass field):
 *   'newsletter'    — List-Unsubscribe, List-Id present
 *   'transactional' — Auto-Submitted≠no, Precedence:bulk|list, Feedback-ID,
 *                     X-Auto-Response-Suppress, noreply sender local-part
 *   'short-body'    — post-strip body has <50 whitespace-split tokens
 *   null            — passed all gates; embed
 */

import EmailReplyParser from 'email-reply-parser';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Tunable: minimum token count after stripping ────────────────────────────
//
// WHY 50 tokens: Hakase external research surfaced Unstructured.io (2024–2025)
// and Open-WebUI as production benchmarks for the post-strip token floor.
// Below ~50 tokens, sentence embeddings collapse to category-level signal —
// they retrieve the noise without contributing semantic uplift.
//
// WHY config/defaults.json: build-conventions forbids hardcoded tunables.
// Future stories tune the floor without editing source. Falls back to 50 if
// the config file is missing (defensive — never throw at module import).

const _REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const _DEFAULTS_PATH = resolve(_REPO_ROOT, 'config', 'defaults.json');

function _loadMinTokens() {
  try {
    if (existsSync(_DEFAULTS_PATH)) {
      const d = JSON.parse(readFileSync(_DEFAULTS_PATH, 'utf8'));
      const n = d?.junkClassifier?.minTokensPostStrip;
      if (Number.isInteger(n) && n > 0) return n;
    }
  } catch { /* fall through to default */ }
  return 50;
}
const MIN_TOKENS_POST_STRIP = _loadMinTokens();

// ── Header signal detection ─────────────────────────────────────────────────
//
// WHY case-insensitive header lookup: gmail-sync's findHeader is case-
// insensitive, but the classifier may also be invoked with a raw lowercased
// dictionary. Accept either.

function _getHeader(headers, name) {
  if (!headers) return null;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) return headers[k];
  }
  return null;
}

/**
 * Returns the junkClass string if any newsletter/transactional signal hits,
 * else null. Order matters only for telemetry — header signals are union.
 *
 * Signals (per RFC 2369, 5064, 8617 + de-facto):
 *   newsletter:    List-Unsubscribe, List-Id, is_newsletter flag
 *   transactional: Feedback-ID, Auto-Submitted ≠ "no", Precedence: bulk|list,
 *                  X-Auto-Response-Suppress: DR|AutoReply|All,
 *                  sender local-part /(noreply|no-reply|donotreply)/i
 */
function _classifyHeaderSignals({ is_newsletter, list_unsubscribe, headers, sender_email, subject }) {
  // WHY check the boolean flag first: gmail-sync sets is_newsletter at sync
  // time based on the widened 7-signal predicate. By the time we get here,
  // is_newsletter=1 is a fast-path verdict — don't re-derive.
  if (is_newsletter) return 'newsletter';
  if (list_unsubscribe) return 'newsletter';

  if (_getHeader(headers, 'list-id')) return 'newsletter';
  if (_getHeader(headers, 'list-unsubscribe')) return 'newsletter';

  if (_getHeader(headers, 'feedback-id')) return 'transactional';

  // RFC 3834: Auto-Submitted MAY be "no", "auto-generated", "auto-replied",
  // or "auto-notified". Anything that is NOT "no" or empty means automated.
  const autoSub = _getHeader(headers, 'auto-submitted');
  if (autoSub && autoSub.toLowerCase().trim() !== 'no') return 'transactional';

  const precedence = _getHeader(headers, 'precedence');
  if (precedence && /^(bulk|list|junk)$/i.test(precedence.trim())) return 'transactional';

  // X-Auto-Response-Suppress: DR (delivery reports) / AutoReply / All.
  // Presence of any value indicates the sender expects auto-handling.
  const xAuto = _getHeader(headers, 'x-auto-response-suppress');
  if (xAuto && /\b(DR|AutoReply|All|NDR|OOF|RN)\b/i.test(xAuto)) return 'transactional';

  // Sender local-part: noreply / no-reply / donotreply / do-not-reply.
  // Pull local-part out of "Name <addr>" form via the @ pivot — sender_email
  // here may be either bare addr ("noreply@x.com") or display form.
  if (sender_email) {
    const at = sender_email.lastIndexOf('@');
    const local = (at > 0 ? sender_email.slice(0, at) : sender_email).toLowerCase();
    if (/(noreply|no-reply|donotreply|do-not-reply)/.test(local)) return 'transactional';
  }

  if (subject && /\b(order|receipt|invoice|payment|subscription|shipping|shipped|delivered|delivery|tracking|arrived|confirmation)\b/i.test(subject)) {
    return 'transactional';
  }

  return null;
}

// ── Body stripping ──────────────────────────────────────────────────────────

const _replyParser = new EmailReplyParser();

// Custom footer/boilerplate regex matchers — strip from the FIRST match.
// WHY strip from first match (not delete-line): legal footers often appear at
// the very tail and account for 40-60% of corporate email length. Truncating
// after the first marker correctly removes the entire trailing block.
//
// WHY these specific patterns: hand-rolled from corpus inspection (Hakase
// finding: footer/boilerplate has no production library — it is universally
// operator-built). Each pattern matches a known high-frequency junk start.
const _FOOTER_PATTERNS = [
  /^--\s*$/m,                                  // standard dash sig delimiter
  /^_{3,}/m,                                   // underscore line delimiter
  /^Sent from my /m,                           // iPhone/iPad/Android default
  /^Get Outlook for /m,                        // Outlook mobile signature
  /this email and any attachments/i,           // legal confidentiality opener
  /if you are not the intended recipient/i,    // legal notice opener
  /confidential(ity)? notice/i,                // legal notice opener
];

function _stripFooter(body) {
  let earliest = body.length;
  for (const pat of _FOOTER_PATTERNS) {
    const m = body.match(pat);
    if (m && m.index !== undefined && m.index < earliest) {
      earliest = m.index;
    }
  }
  return body.slice(0, earliest);
}

/**
 * Strip an email body in the canonical order:
 *   1. HTML tag strip
 *   2. Quoted-reply (email-reply-parser)
 *   3. Footer/boilerplate regex
 *
 * Returns the stripped string (may be empty). Pure function.
 */
function _stripEmailBody(body) {
  if (!body || typeof body !== 'string') return '';

  // 1. HTML tag strip — Gmail bodies may include HTML fragments mixed with
  //    text. email-reply-parser works on plain text; HTML tags would confuse
  //    its regex-based reply detection.
  const noHtml = body.replace(/<[^>]+>/g, ' ');

  // 2. Quoted-reply + library signature strip via email-reply-parser.
  //    .getVisibleText() returns the message minus quoted reply and trailing
  //    "Best regards / Sent from my iPhone"-style sig blocks.
  let visible;
  try {
    visible = _replyParser.read(noHtml).getVisibleText();
  } catch {
    // Defensive: parser failures fall through to the un-parsed body. The
    // footer regex pass still runs. This guards against odd inputs that the
    // parser's RE2/regex layer rejects — a parser bug must never crash the
    // chunk pipeline.
    visible = noHtml;
  }

  // 3. Custom footer pass — strips legal boilerplate and OS sigs the library
  //    does not consistently catch (especially the legal "this email and any
  //    attachments" blocks common in corporate mail).
  return _stripFooter(visible).trim();
}

/**
 * Approximate token count via whitespace split. Pure function.
 *
 * WHY whitespace count, not a real tokenizer: a real BPE tokenizer would
 * require pulling in tiktoken (~5 MB) and adding a CPU-bound step on every
 * chunk. Whitespace count is within ±15% of GPT/Claude tokens for English
 * email text — well within the 50-token floor's noise band. The point of the
 * floor is to reject pleasantries, not to count atomically.
 */
function _approxTokens(s) {
  if (!s) return 0;
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Classify a chunk for embedding.
 *
 * @param {object} input
 * @param {string} input.source_type   — 'email' | 'drive' | 'imessage' | ...
 * @param {string} input.body          — raw body text (may include HTML)
 * @param {string} [input.sender_email]
 * @param {string} [input.subject]
 * @param {number} [input.is_newsletter] — 0|1 flag from gmail-sync
 * @param {string} [input.list_unsubscribe] — header value from emails table
 * @param {object} [input.headers]     — raw header dict for unflagged signals
 *
 * @returns {{shouldEmbed: boolean, junkClass: string|null, strippedBody: string|null}}
 */
export function classifyChunk(input) {
  const {
    source_type,
    body = '',
    sender_email,
    subject,
    is_newsletter,
    list_unsubscribe,
    headers,
  } = input || {};

  // iMessage carve-out — FIRST guard, load-bearing.
  // scripts/extract-imessage/01-extract.js:278 reads chunks for participant
  // metadata. Any filtering here would break that pipeline. The owner
  // confirmed this carve-out in the framing session; AC4 of 00-scope.md
  // codifies it.
  if (source_type === 'imessage') {
    return { shouldEmbed: true, junkClass: null, strippedBody: body };
  }

  // Drive carve-out for header signals — drive bodies have no email headers,
  // so the newsletter/transactional gate is inert. Drive still gets the
  // body-substance check (a 3-token Drive doc is still junk).
  if (source_type === 'drive') {
    const stripped = (body || '').trim();
    if (_approxTokens(stripped) < MIN_TOKENS_POST_STRIP) {
      return { shouldEmbed: false, junkClass: 'short-body', strippedBody: stripped };
    }
    return { shouldEmbed: true, junkClass: null, strippedBody: stripped };
  }

  const stripped = _stripEmailBody(body);
  // Email path (and any other source_type that may grow header semantics).
  // Return strippedBody even when a header class marks the row low-value. The
  // chunk worker may still keep readable transactional mail retrievable; if it
  // does, the embed input must be the visible message, not the quoted raw thread.
  const headerClass = _classifyHeaderSignals({ is_newsletter, list_unsubscribe, headers, sender_email, subject });
  if (headerClass) {
    return { shouldEmbed: false, junkClass: headerClass, strippedBody: stripped };
  }

  if (_approxTokens(stripped) < MIN_TOKENS_POST_STRIP) {
    return { shouldEmbed: false, junkClass: 'short-body', strippedBody: stripped };
  }

  return { shouldEmbed: true, junkClass: null, strippedBody: stripped };
}

// Named export of the tunable so tests / callers can sanity-check the load.
export { MIN_TOKENS_POST_STRIP };
