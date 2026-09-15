/**
 * Profile research library — LinkedIn, Crunchbase, Brave, Sonnet synthesis.
 * Writes ## Summary, ## About, ## Relationship sections to entity context files.
 *
 * Two execution paths:
 *   /profile skill  — caller does Playwright MCP extractions, passes
 *                     linkedinData / crunchbaseData to the research functions.
 *   followup-sweep  — runs as a Node.js server process; no Playwright available.
 *                     When linkedinData / crunchbaseData is null, the function
 *                     falls back to Brave-only research.
 *
 * @module profile-research
 * @see docs/profile-schema.md
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { llmCreate } from './llm-gateway.js';
import { braveSearch } from './brave-search.js';
import { modelFor } from './model-lane.js';

export const INTELLIGENCE_TIER = 'synthesis';

// ── Section merge ──────────────────────────────────────────────────────────────

/**
 * Merge ## Summary, ## About, ## Relationship into an existing context file.
 * All other sections are preserved byte-for-byte. Frontmatter keys are upserted.
 *
 * @param {string|null} existingContent - Current file text, or null for fresh file.
 * @param {object} sections
 * @param {string} sections.summarySection   - Full "## Summary\n..." block
 * @param {string} sections.aboutSection     - Full "## About\n..." block
 * @param {string} sections.relationshipStub - Full "## Relationship\n..." block
 * @param {object} sections.frontmatterPatch - Key/value pairs to upsert into YAML frontmatter
 * @returns {string} Merged file content
 */
export function mergeProfileSections(existingContent, sections) {
  const { summarySection, aboutSection, relationshipStub, frontmatterPatch = {} } = sections;

  // Fresh file path
  if (!existingContent) {
    const fm = buildFrontmatter({}, frontmatterPatch);
    return `${fm}\n${summarySection}\n\n${aboutSection}\n\n${relationshipStub}\n`;
  }

  // Content integrity guard — reject clearly broken merges
  const originalLen = existingContent.length;

  // --- YAML frontmatter ---
  let content = existingContent;
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  let currentFm = {};
  if (fmMatch) {
    // Parse simple key: value YAML (no nesting needed here)
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^(\w[\w_-]*):\s*(.*)/);
      if (m) currentFm[m[1]] = m[2].trim();
    }
  }
  const mergedFm = { ...currentFm, ...frontmatterPatch };
  const newFmBlock = buildFrontmatter(mergedFm);

  if (fmMatch) {
    content = content.replace(/^---\n[\s\S]*?\n---\n/, newFmBlock);
  } else {
    content = newFmBlock + content;
  }

  // --- Replace owned sections ---
  const owned = ['Summary', 'About', 'Relationship'];
  const replacements = {
    Summary: summarySection,
    About: aboutSection,
    Relationship: relationshipStub,
  };

  for (const name of owned) {
    // End boundary is the next "## " heading OR true end-of-input. NOTE: `\Z` is
    // NOT a JavaScript anchor (it matches a literal "Z"), so the old pattern
    // failed to bound the LAST section (Relationship) — the replace missed and
    // the section was appended, duplicating it on every refresh. `$(?![\s\S])`
    // is the correct end-of-input anchor under the `m` flag.
    const sectionRe = new RegExp(`^## ${name}[ \\t]*\\n[\\s\\S]*?(?=^## |$(?![\\s\\S]))`, 'm');
    const newBlock = replacements[name].trimEnd() + '\n\n';
    if (sectionRe.test(content)) {
      content = content.replace(sectionRe, newBlock);
    } else {
      // Section doesn't exist yet — append before the first non-owned ## heading or at end
      content = content.trimEnd() + '\n\n' + replacements[name].trimEnd() + '\n';
    }
  }

  // Integrity guard: merged result must not be shorter than 20% of original
  if (content.length < originalLen * 0.2) {
    console.warn(`[profile-research] mergeProfileSections integrity guard triggered — returning original (merged ${content.length} vs original ${originalLen})`);
    return existingContent;
  }

  return content;
}

/**
 * Build a YAML frontmatter block from a key/value object.
 * @param {object} base
 * @param {object} patch
 * @returns {string}
 */
function buildFrontmatter(base = {}, patch = {}) {
  const merged = { ...base, ...patch };
  const entries = Object.entries(merged).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${entries}\n---\n`;
}

// ── Crunchbase extraction ──────────────────────────────────────────────────────

/**
 * Extract structured data from a Crunchbase page's #ng-state JSON blob.
 * Pass the raw HTML string (from Playwright evaluate or page.content()).
 * @param {string} pageHtml
 * @returns {object} crunchbaseData fields or empty object on failure
 */
export function extractCrunchbaseNgState(pageHtml) {
  try {
    const match = pageHtml.match(/id="ng-state"[^>]*>([\s\S]*?)<\/script>/i);
    const raw = match?.[1]?.trim() || '';
    const parsed = raw ? JSON.parse(raw) : {};
    const org = parsed?.HttpState?.['GET/entities/organizations']?.data?.properties
              || parsed?.props?.pageProps?.entity?.properties
              || {};
    return {
      short_description: org.short_description || org.description || '',
      website_url: org.homepage_url || org.website_url || '',
      funding_stage: org.last_equity_funding_type || org.funding_stage || '',
      total_raised: org.total_funding_amount_value
        ? `$${(org.total_funding_amount_value / 1e6).toFixed(1)}M` : '',
      lead_investors: (org.lead_investors || []).map(i => i.value?.entity_def_id || i.value?.name || i).filter(Boolean),
      employee_range: org.num_employees_enum || '',
    };
  } catch (err) {
    console.warn(`[profile-research] extractCrunchbaseNgState parse error: ${err.message}`);
    return {};
  }
}

// ── Brave fan-out helpers ──────────────────────────────────────────────────────

/**
 * Fetch and strip HTML from a URL. Returns up to 2000 chars of text.
 * Never throws — returns empty string on failure.
 */
async function fetchPageText(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return '';
    const html = await res.text();
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000);
  } catch {
    return '';
  }
}

/**
 * Run one Brave query and fetch page text for the top N non-excluded URLs.
 * @param {string} query
 * @param {number} topFetch - How many non-excluded URLs to fetch page text for
 * @param {string} excludeDomain - Skip URLs containing this string (e.g. 'linkedin.com')
 * @returns {Promise<string>} Combined snippet + page text
 */
async function braveQueryAndFetch(query, topFetch = 2, excludeDomain = '') {
  const results = await braveSearch(query, { count: 5, extraSnippets: true });
  const parts = [];
  let fetched = 0;
  for (const r of results) {
    // Combine all snippet text from this result
    const snippetText = [r.snippet, ...(r.extraSnippets || [])].filter(Boolean).join(' ');
    if (snippetText) parts.push(snippetText);

    if (fetched < topFetch && (!excludeDomain || !r.url.includes(excludeDomain))) {
      const pageText = await fetchPageText(r.url);
      if (pageText) parts.push(pageText);
      fetched++;
    }
  }
  return parts.join('\n');
}

// ── Relationship helpers (deterministic interaction graph) ──────────────────────

/**
 * Build the ## Relationship body for a person from person_interactions.
 *
 * person_interactions holds one row per resolved contact event (channel ∈
 * meeting/email/imessage/calendar), keyed by person_id. This is the canonical
 * relationship signal — read it by id, never by matching a display name against
 * free text. Returns a single declarative line. Never throws.
 *
 * @param {object} db
 * @param {string|null} entityId - people.id
 * @returns {string}
 */
function buildPersonRelationshipBody(db, entityId) {
  if (!entityId) return 'Key dynamic: unknown. No interaction history on record.';
  try {
    const rows = db.prepare(
      `SELECT channel, COUNT(*) AS n, MAX(date) AS last
         FROM person_interactions
        WHERE person_id = ?
        GROUP BY channel`,
    ).all(entityId);
    if (!rows.length) return 'Key dynamic: unknown. No interaction history on record.';

    const total = rows.reduce((s, r) => s + r.n, 0);
    const lastDate = rows.map(r => r.last).filter(Boolean).sort().pop() || 'unknown';
    const lastRow = rows.filter(r => r.last === lastDate)[0];
    const breakdown = rows
      .slice()
      .sort((a, b) => b.n - a.n)
      .map(r => `${r.n} ${r.channel}${r.n === 1 ? '' : 's'}`)
      .join(', ');
    return `Last connected ${lastDate}${lastRow ? ` via ${lastRow.channel}` : ''}. ${total} interaction${total === 1 ? '' : 's'} on record: ${breakdown}.`;
  } catch (err) {
    console.warn(`[profile-research] buildPersonRelationshipBody error: ${err.message}`);
    return 'Key dynamic: unknown. Interaction history unavailable.';
  }
}

/**
 * Build the ## Relationship body for a company from the interaction graph of
 * the people linked to it (people.company_id). Returns a declarative line.
 * Never throws.
 *
 * @param {object} db
 * @param {string|null} entityId - companies.id
 * @param {string} name - company name (for the hint fallback)
 * @param {string|null} hint
 * @returns {string}
 */
function buildCompanyRelationshipBody(db, entityId, name, hint) {
  try {
    let contacts = [];
    let lastEvent = null;
    if (entityId) {
      contacts = db.prepare(
        `SELECT display_name FROM people WHERE company_id = ? AND archived = 0 LIMIT 3`,
      ).all(entityId).map(r => r.display_name).filter(Boolean);
      lastEvent = db.prepare(
        `SELECT MAX(pi.date) AS last
           FROM person_interactions pi
           JOIN people p ON p.id = pi.person_id
          WHERE p.company_id = ?`,
      ).get(entityId);
    }
    const contactsStr = contacts.length ? contacts.join(', ') : 'none identified yet';
    const lastStr = lastEvent?.last ? `Last contact with someone there: ${lastEvent.last}.` : 'No direct interaction on record yet.';
    return `Context: ${hint || 'known company'}. Known contacts: ${contactsStr}. ${lastStr}`;
  } catch (err) {
    console.warn(`[profile-research] buildCompanyRelationshipBody error: ${err.message}`);
    return `Context: ${hint || 'known company'}. Relationship history unavailable.`;
  }
}

// ── Person research ────────────────────────────────────────────────────────────

/**
 * Research a person and return profile sections.
 *
 * When linkedinData is provided (from Playwright extraction by the /profile skill),
 * it is used for the ## Summary. Otherwise, Brave-only.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string|null} opts.linkedinUrl
 * @param {object|null} opts.linkedinData - Pre-fetched: { name, headline, company, location, description }
 * @param {string|null} opts.hint - Call context hint
 * @param {object} opts.db - better-sqlite3 db instance
 * @returns {Promise<{summarySection, aboutSection, relationshipStub, frontmatterPatch}>}
 */
export async function researchPerson({ name, linkedinUrl = null, linkedinData = null, hint = null, db, entityId = null }) {
  // ── 1. Brave fan-out ──────────────────────────────────────────────────────
  // Six queries: general, career, domain/writing (no LinkedIn → emphasise output),
  // interview/profile coverage, company-scoped if known, news.
  const hasLinkedIn = !!linkedinData?.company;
  const queries = [
    `"${name}"`,
    hasLinkedIn ? `"${name}" "${linkedinData.company}"` : `"${name}" writing OR work OR research OR ideas`,
    `"${name}" interview OR profile OR biography`,
    `"${name}" career background`,
    `"${name}" news OR announcement`,
  ].filter(Boolean);

  if (hint && !hasLinkedIn) {
    queries.push(`"${name}" "${hint}"`);
  }

  const braveTexts = await Promise.all(
    queries.map(q => braveQueryAndFetch(q, 2, 'linkedin.com'))
  );
  const combinedText = [
    linkedinData?.description || '',
    ...braveTexts,
  ].filter(Boolean).join('\n').slice(0, 10000);

  // ── 2. Sonnet synthesis → ## About ───────────────────────────────────────
  let aboutBody = '';
  try {
    const msg = await llmCreate({
      model: modelFor('balanced'),
      max_tokens: 1500,
      cache: 'system',
      system: 'You synthesize factual profiles for personal use. Write in third person. Be specific and declarative — avoid generic phrases. No hedging. No outreach suggestions. No warm-intro language.',
      messages: [{ role: 'user', content: `Write a substantive profile of ${name}. Cover each section below with a bold header, using only what the source material supports — skip sections with no data.

**Current Role** — what they do and where; include publication, company, or platform name
**Known For** — their specific domain, signature ideas, key intellectual positions, or most notable work
**Background** — education and career history
**Work & Output** — specific books, essays, research, podcasts, or other outputs worth naming
**Reach** — audience size, platform, notable press, key collaborators
**Recent Activity** — what they are working on or have done recently

Be specific. Prefer named works and verifiable facts over adjectives.

Source material:
${combinedText}` }],
    }, 'profile-research-person');
    aboutBody = msg.content?.[0]?.text?.trim() || '';
  } catch (err) {
    console.warn(`[profile-research] researchPerson Sonnet error: ${err.message}`);
    aboutBody = `Profile synthesis unavailable: ${err.message}`;
  }

  // ── 3. ## Relationship stub from the deterministic interaction graph ──────
  // person_interactions is the canonical relationship signal (one row per
  // resolved contact event: meeting, email, imessage, calendar), keyed by
  // person_id. We read it by entityId — never by LIKE-matching transcript text
  // or email addresses against a display name, which collides across same-named
  // people and silently degraded against stale column names before this fix.
  const relationshipBody = buildPersonRelationshipBody(db, entityId);

  // ── 4. ## Summary block ───────────────────────────────────────────────────
  const company = linkedinData?.company || 'unknown';
  const headline = linkedinData?.headline || 'unknown';
  const location = linkedinData?.location || 'unknown';
  const twitter = linkedinData?.twitter || '';
  const resolvedLinkedInUrl = linkedinUrl || '';

  const summarySection = `## Summary\ncompany: ${company}\ncurrent_role: ${headline}\nlocation: ${location}\nlinkedin_url: ${resolvedLinkedInUrl}\ntwitter: ${twitter}`;
  const aboutSection = `## About\n${aboutBody}`;
  const relationshipStub = `## Relationship\n${relationshipBody}`;

  return {
    summarySection,
    aboutSection,
    relationshipStub,
    frontmatterPatch: {
      linkedin_url: resolvedLinkedInUrl,
      web_refreshed_at: new Date().toISOString(),
    },
  };
}

// ── Company research ───────────────────────────────────────────────────────────

/**
 * Research a company and return profile sections.
 *
 * When crunchbaseData is provided (from Playwright extraction by the /profile skill),
 * it is used for the ## Summary. Otherwise, Brave-only.
 *
 * @param {object} opts
 * @param {string} opts.name
 * @param {string|null} opts.crunchbaseUrl
 * @param {object|null} opts.crunchbaseData - Pre-fetched: { short_description, website_url, funding_stage, total_raised, lead_investors, employee_range }
 * @param {string|null} opts.hint
 * @param {object} opts.db
 * @returns {Promise<{summarySection, aboutSection, relationshipStub, frontmatterPatch}>}
 */
export async function researchCompany({ name, crunchbaseUrl = null, crunchbaseData = null, hint = null, db, entityId = null }) {
  // ── 1. Brave fan-out ──────────────────────────────────────────────────────
  const queries = [
    `"${name}" company`,
    `"${name}" funding OR investment`,
    `"${name}" product OR technology`,
    `"${name}" news OR announcement`,
  ];

  const braveTexts = await Promise.all(
    queries.map(q => braveQueryAndFetch(q, 1, 'crunchbase.com'))
  );
  const combinedText = [
    crunchbaseData?.short_description || '',
    ...braveTexts,
  ].filter(Boolean).join('\n').slice(0, 8000);

  // ── 2. Sonnet synthesis → ## About ───────────────────────────────────────
  let aboutBody = '';
  try {
    const msg = await llmCreate({
      model: modelFor('balanced'),
      max_tokens: 1024,
      cache: 'system',
      system: 'You synthesize factual profiles for personal use. Write in third person. Be specific and declarative. No hedging. No outreach suggestions. No warm-intro language.',
      messages: [{ role: 'user', content: `Write a factual company profile of ${name}. Fields to cover: what the company does, market position, funding, team size, key people, recent news.\n\nSource material:\n${combinedText}` }],
    }, 'profile-research-company');
    aboutBody = msg.content?.[0]?.text?.trim() || '';
  } catch (err) {
    console.warn(`[profile-research] researchCompany Sonnet error: ${err.message}`);
    aboutBody = `Company profile synthesis unavailable: ${err.message}`;
  }

  // ── 3. ## Relationship stub from the deterministic interaction graph ──────
  const relationshipBody = buildCompanyRelationshipBody(db, entityId, name, hint);

  // ── 4. ## Summary block ───────────────────────────────────────────────────
  const short_description = crunchbaseData?.short_description || 'unknown';
  const website_url = crunchbaseData?.website_url || 'unknown';
  const funding_stage = crunchbaseData?.funding_stage || 'unknown';
  const total_raised = crunchbaseData?.total_raised || 'unknown';
  const investors = crunchbaseData?.lead_investors || [];
  const num_employees_enum = crunchbaseData?.employee_range || 'unknown';
  const resolvedCrunchbaseUrl = crunchbaseUrl || '';

  const summarySection = `## Summary\ndescription: ${short_description}\nwebsite: ${website_url}\nfunding_stage: ${funding_stage}\ntotal_raised: ${total_raised}\nlead_investors: ${Array.isArray(investors) ? investors.join(', ') || 'unknown' : investors || 'unknown'}\nemployee_range: ${num_employees_enum}`;
  const aboutSection = `## About\n${aboutBody}`;
  const relationshipStub = `## Relationship\n${relationshipBody}`;

  return {
    summarySection,
    aboutSection,
    relationshipStub,
    frontmatterPatch: {
      ...(resolvedCrunchbaseUrl ? { crunchbase_url: resolvedCrunchbaseUrl } : {}),
      ...(website_url !== 'unknown' ? { website: website_url } : {}),
      web_refreshed_at: new Date().toISOString(),
    },
  };
}

// ── Entity resolution from URL ─────────────────────────────────────────────────

/**
 * Resolve or create an entity from a URL. Used by the /profile skill.
 *
 * URL routing:
 *   linkedin.com/in/    → person
 *   linkedin.com/company/ → company
 *   crunchbase.com/organization/ → company
 *
 * @param {string} url
 * @param {string|null} hintName - Caller-supplied name hint
 * @param {object} db
 * @param {'person'|'company'|null} [hintType] - explicit type override; when set, overrides URL-based inference
 * @returns {Promise<{entityId: string, entityType: 'person'|'company', created: boolean}>}
 */
export async function resolveEntityFromUrl(url, hintName, db, hintType = null) {
  if (!url) throw new Error('resolveEntityFromUrl: url is required');

  const urlIsPerson = url.includes('linkedin.com/in/');
  const isLinkedInOrCrunchbaseCompany = url.includes('linkedin.com/company/') || url.includes('crunchbase.com/organization/');
  const isWebsiteUrl = !urlIsPerson && !isLinkedInOrCrunchbaseCompany;
  // hintType overrides URL-based inference for website URLs (linkedin.com/in/ is always person,
  // linkedin.com/company/ and crunchbase.com/organization/ are always company)
  const isPerson = hintType === 'person' ? true : (hintType === 'company' ? false : urlIsPerson);
  const isCompany = hintType === 'company' ? true : (hintType === 'person' ? false : (isLinkedInOrCrunchbaseCompany || isWebsiteUrl));

  if (isPerson) {
    // Dedup by the LinkedIn URL first — the URL is the strong identity for a
    // /profile call. resolvePerson alone only dedupes by email/phone, so a
    // name+URL call created a NEW duplicate person on every run. Match by URL,
    // then by exact display name, before creating. Idempotent on re-run.
    const normUrl = url.replace(/\/+$/, '');
    let existing = db.prepare(
      `SELECT id FROM people WHERE linkedin_url IN (?, ?) AND archived = 0 LIMIT 1`,
    ).get(normUrl, `${normUrl}/`);
    if (!existing && hintName) {
      existing = db.prepare(
        `SELECT id FROM people WHERE display_name = ? AND archived = 0 ORDER BY rowid LIMIT 1`,
      ).get(hintName);
    }
    if (existing) {
      // Backfill the LinkedIn URL so future runs dedup by URL directly.
      try {
        db.prepare(`UPDATE people SET linkedin_url = ? WHERE id = ? AND (linkedin_url IS NULL OR linkedin_url = '')`).run(normUrl, existing.id);
      } catch { /* best-effort */ }
      return { entityId: existing.id, entityType: 'person', created: false };
    }
    const { resolvePerson } = await import('./entity-resolve.js');
    const result = resolvePerson({ name: hintName, source: 'profile-skill' });
    try {
      db.prepare(`UPDATE people SET linkedin_url = ? WHERE id = ?`).run(normUrl, result.id);
    } catch { /* best-effort */ }
    return { entityId: result.id, entityType: 'person', created: result.created || false };
  }

  if (isCompany) {
    // Companies: look up by name in DB, or create via direct insert
    if (isWebsiteUrl) {
      try {
        const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
        const hostname = new URL(normalizedUrl).hostname.replace(/^www\./, '').toLowerCase();
        const byDomain = db.prepare(
          `SELECT c.id FROM companies c JOIN company_domains cd ON cd.company_id = c.id WHERE cd.domain = ? LIMIT 1`
        ).get(hostname);
        if (byDomain) return { entityId: byDomain.id, entityType: 'company', created: false };
      } catch { /* malformed URL — fall through to name dedup */ }
    }
    const existing = db.prepare(`SELECT id FROM companies WHERE name LIKE ? LIMIT 1`).get(`%${hintName}%`);
    if (existing) {
      return { entityId: existing.id, entityType: 'company', created: false };
    }
    // Create a minimal company record
    const { randomUUID } = await import('node:crypto');
    const id = randomUUID().replace(/-/g, '').slice(0, 32);
    try {
      db.prepare(`INSERT OR IGNORE INTO companies (id, name, company_type, created_at, updated_at) VALUES (?, ?, 'company', datetime('now'), datetime('now'))`).run(id, hintName);
      if (isWebsiteUrl) {
        try {
          const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;
          const hostname = new URL(normalizedUrl).hostname.replace(/^www\./, '').toLowerCase();
          db.prepare(`INSERT OR IGNORE INTO company_domains (company_id, domain, created_at) VALUES (?, ?, datetime('now'))`).run(id, hostname);
        } catch { /* best-effort */ }
      }
      return { entityId: id, entityType: 'company', created: true };
    } catch (err) {
      console.warn(`[profile-research] resolveEntityFromUrl company insert error: ${err.message}`);
      // Try to find whatever was inserted
      const row = db.prepare(`SELECT id FROM companies WHERE name = ? LIMIT 1`).get(hintName);
      if (row) return { entityId: row.id, entityType: 'company', created: false };
      throw err;
    }
  }

  // All non-person URLs are treated as company.
}
