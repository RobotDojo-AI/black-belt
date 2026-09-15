/**
 * lib/referral/signature-scan.js — st_b879a361
 *
 * extractSignatureSignal(bodyText, canonicalDomains)
 *   → { role, domain, title } | null
 *
 * Scans the email signature zone for co-occurrence of a role keyword AND a
 * canonical-domain reference within ±3 lines.
 *
 * ALGORITHM
 *   1. Truncate body at the first quote marker (^>, ^On .+ wrote:$,
 *      ^-----Original Message-----$, ^From: ). Quote-truncation prevents a
 *      marketer's reply from picking up a quoted "Co-founder, Stripe" line
 *      in the body below and inheriting the wrong sender's identity.
 *   2. Take the last 15 non-empty lines of the truncated body.
 *   3. For each line that mentions a canonical domain (URL form, @company,
 *      or bare domain), look at the ±3 line window for a role keyword. If
 *      both present → return { role, domain, title }.
 *
 * DOMAIN REFERENCE FORMS
 *   - https?://(www\.)?<dom>     — explicit URL
 *   - bare <dom>                 — token equals canonical domain
 *   - @ <Company Name>           — handled implicitly by the URL form being
 *                                  paired with a role line; @-mention without
 *                                  a domain we can't disambiguate, so it does
 *                                  not contribute on its own.
 *
 * ROLE LINE
 *   Detected via lightweight regex (a subset of the ontology — full classify
 *   happens later in qualifyPerson(). The signature scan only needs to KNOW
 *   if there's a role-like keyword, not which bucket it lands in).
 *
 * RETURNS
 *   { role: 'founder'|...|'business', domain: 'stripe.com', title: 'Co-founder, Stripe' }
 *   or null if no match.
 */

import { classifyRole } from './role-classify.js';
import { classifyDomain } from './canonical-domains.js';

// Quote markers — body content at and below the FIRST match is dropped.
// Anchored to line start (after the per-line split) to avoid false hits in
// prose like "I love what you wrote on the topic of...".
const QUOTE_MARKERS = [
  /^>/,
  /^On\s.+wrote:\s*$/i,
  /^-----\s*Original Message\s*-----\s*$/i,
  /^From:\s/i,
];

// Role keyword pattern for SCAN-time presence detection only. Final bucket
// classification uses ontologies.js via classifyRole(). This pattern is
// intentionally inclusive — we want to find ANY role-like line and pass the
// title string to the classifier.
const ROLE_PATTERN = /\b(?:Co[\s-]?founder|Cofounder|Founder|Founding\s+(?:Engineer|Designer)|CEO|CTO|COO|CFO|CIO|CPO|CMO|Chief\s+\w+\s+Officer|Chief\s+of\s+Staff|VP|SVP|EVP|Vice\s+President|Head\s+of\s+\w+|Engineer|Engineering|Developer|Designer|Architect|Director|Manager|Partner|Principal|Associate|Analyst|Investor|EIR|Sales|Product\s+Manager|Operations|Strategy|Account\s+Executive)\b/i;

const URL_HOST_RE = /https?:\/\/(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/i;
// Bare domain: one or more labels followed by a TLD (e.g. anthropic.com,
// sequoiacap.com, www.figma.com, ai.huggingface.co). Requires at least one
// dot; the TLD must be ≥2 alpha chars.
const BARE_DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i;

function truncateAtQuote(body) {
  const lines = String(body || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    for (const re of QUOTE_MARKERS) {
      if (re.test(ln)) return lines.slice(0, i);
    }
  }
  return lines;
}

function lastNonEmptyLines(lines, n) {
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const ln = lines[i].trim();
    if (ln.length > 0) out.unshift(ln);
  }
  return out;
}

/**
 * Find canonical domain references on a single line.
 * @param {string} line
 * @param {Set<string>} canonicalDomains
 * @returns {string|null} the matched canonical domain, lowercase, or null
 */
function matchCanonicalDomain(line, canonicalDomains) {
  // Try URL-form first (most specific).
  const urlHit = URL_HOST_RE.exec(line);
  if (urlHit) {
    const host = urlHit[1].toLowerCase().replace(/^www\./, '');
    if (canonicalDomains.has(host)) return host;
  }
  // Then bare-token domain anywhere in the line.
  let m;
  const re = new RegExp(BARE_DOMAIN_RE.source, 'gi');
  while ((m = re.exec(line)) !== null) {
    const host = m[1].toLowerCase().replace(/^www\./, '');
    if (canonicalDomains.has(host)) return host;
  }
  return null;
}

/**
 * @param {string} bodyText — full email body
 * @param {Set<string>} canonicalDomains — getCanonicalDomains() output
 * @returns {{role: string, domain: string, title: string}|null}
 */
export function extractSignatureSignal(bodyText, canonicalDomains) {
  if (!bodyText || !canonicalDomains || canonicalDomains.size === 0) return null;

  const truncated = truncateAtQuote(bodyText);
  const sigLines = lastNonEmptyLines(truncated, 15);
  if (sigLines.length === 0) return null;

  // First pass: locate canonical-domain hits per line, plus role-pattern hits.
  const domainHits = []; // [{ idx, domain }]
  const roleHits = [];   // [{ idx, line }]
  for (let i = 0; i < sigLines.length; i++) {
    const line = sigLines[i];
    const dom = matchCanonicalDomain(line, canonicalDomains);
    if (dom) domainHits.push({ idx: i, domain: dom });
    if (ROLE_PATTERN.test(line)) roleHits.push({ idx: i, line });
  }

  if (domainHits.length === 0 || roleHits.length === 0) return null;

  // Co-occurrence: domain on line D, role on line R, |D - R| <= 3.
  for (const dh of domainHits) {
    for (const rh of roleHits) {
      if (Math.abs(dh.idx - rh.idx) <= 3) {
        const { companyType } = classifyDomain(dh.domain);
        const { bucket } = classifyRole(rh.line, companyType || 'unknown');
        if (bucket === 'excluded') continue; // role line was marketing — skip
        return { role: bucket, domain: dh.domain, title: rh.line };
      }
    }
  }

  return null;
}
