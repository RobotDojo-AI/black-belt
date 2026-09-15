/**
 * LinkedIn profile scraper — professional enrichment via public HTML + DuckDuckGo.
 *
 * Strategy:
 *   - fetchLinkedInProfile: GET /in/<slug>, parse JSON-LD Person schema, fall back to og: tags.
 *   - searchLinkedInByEmailDomain: DuckDuckGo HTML search for "name site:linkedin.com/in",
 *     filter results whose headline/employer contains the email domain.
 *   - enrichPersonFromLinkedIn: orchestrates DB lookup → search → update.
 *
 * Hard rules:
 *   - Never parallelize LinkedIn fetches (1–2 s jitter between each).
 *   - 5 retries max, exponential backoff on 429/503.
 *   - Return null on any error — never throw.
 *   - Log with [linkedin] prefix at info level.
 */

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/124.0.0.0 Safari/537.36';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.info(`[linkedin] ${msg}`);
}

/** Random jitter between 1 000–2 200 ms. */
function jitterMs() {
  return 1000 + Math.floor(Math.random() * 1200);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * fetch() with exponential backoff on 429/503. Returns null on terminal failure.
 * @param {string} url
 * @param {RequestInit} [opts]
 * @returns {Promise<Response|null>}
 */
async function fetchWithRetry(url, opts = {}) {
  const maxRetries = 5;
  let delay = 2000;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          ...(opts.headers || {}),
        },
        signal: AbortSignal.timeout(15000),
      });

      if (res.status === 429 || res.status === 503) {
        log(`rate limited (${res.status}) on attempt ${attempt}/${maxRetries} — sleeping ${delay}ms`);
        await sleep(delay);
        delay *= 2;
        continue;
      }

      return res;
    } catch (err) {
      if (attempt === maxRetries) {
        log(`fetch failed after ${maxRetries} attempts: ${err.message}`);
        return null;
      }
      log(`fetch error (attempt ${attempt}): ${err.message} — retrying in ${delay}ms`);
      await sleep(delay);
      delay *= 2;
    }
  }

  return null;
}

// ─── JSON-LD parser ───────────────────────────────────────────────────────────

/**
 * Extract the first application/ld+json block that is @type Person.
 * LinkedIn injects this server-side on public /in/ pages.
 * @param {string} html
 * @returns {object|null}
 */
function extractJsonLd(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'Person') return item;
      }
    } catch {
      // malformed JSON-LD — skip
    }
  }
  return null;
}

/**
 * Extract og: meta tags as a flat key→value map.
 * @param {string} html
 * @returns {Record<string,string>}
 */
function extractOgTags(html) {
  const og = {};
  const re = /<meta[^>]+property=["'](og:[^"']+)["'][^>]+content=["']([^"']*)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    og[m[1]] = m[2];
  }
  return og;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch and parse a LinkedIn public profile page.
 *
 * @param {string} linkedinUrl  e.g. "https://www.linkedin.com/in/satya-nadella"
 * @returns {Promise<{name:string,headline:string,employer:string,location:string,about:string,linkedinUrl:string,fetchedAt:string}|null>}
 */
export async function fetchLinkedInProfile(linkedinUrl) {
  if (!linkedinUrl || !linkedinUrl.includes('linkedin.com/in/')) {
    log(`invalid LinkedIn URL: ${linkedinUrl}`);
    return null;
  }

  // Normalise to https://www.linkedin.com/in/<slug>
  const normalised = linkedinUrl.replace(/^http:/, 'https:').replace('://linkedin.com', '://www.linkedin.com');

  log(`fetching profile: ${normalised}`);

  try {
    const res = await fetchWithRetry(normalised);
    if (!res) return null;

    if (!res.ok) {
      log(`non-OK response ${res.status} for ${normalised}`);
      return null;
    }

    const html = await res.text();

    // --- Primary: JSON-LD Person schema ---
    const ld = extractJsonLd(html);
    if (ld) {
      const employer = ld.worksFor
        ? (Array.isArray(ld.worksFor) ? ld.worksFor[0]?.name : ld.worksFor?.name) || ''
        : '';
      return {
        name:       ld.name       || '',
        headline:   ld.description || ld.jobTitle || '',
        employer,
        location:   ld.address?.addressLocality || ld.homeLocation?.name || '',
        about:      '',
        linkedinUrl: normalised,
        fetchedAt:  new Date().toISOString(),
      };
    }

    // --- Fallback: og: tags ---
    const og = extractOgTags(html);
    if (og['og:title']) {
      // og:title is typically "Name | LinkedIn" or "Name - Title - Company | LinkedIn"
      const rawTitle = og['og:title'].replace(/\s*\|\s*LinkedIn.*$/i, '').trim();
      const parts = rawTitle.split(/\s*[-–|]\s*/);
      const name = parts[0]?.trim() || '';
      const headline = parts.slice(1).join(' — ').trim();

      return {
        name,
        headline,
        employer: '',
        location: '',
        about:    og['og:description'] || '',
        linkedinUrl: normalised,
        fetchedAt: new Date().toISOString(),
      };
    }

    log(`no parseable profile data at ${normalised}`);
    return null;
  } catch (err) {
    log(`error parsing profile ${normalised}: ${err.message}`);
    return null;
  }
}

/**
 * Search DuckDuckGo HTML for "name site:linkedin.com/in", filter results by
 * emailDomain appearing in the headline or employer field of the top match.
 *
 * DuckDuckGo HTML endpoint does not block headless fetches.
 *
 * @param {string} name        Full name to search for
 * @param {string} emailDomain e.g. "microsoft.com"
 * @returns {Promise<{name:string,headline:string,employer:string,location:string,about:string,linkedinUrl:string,fetchedAt:string}|null>}
 */
export async function searchLinkedInByEmailDomain(name, emailDomain) {
  if (!name || !emailDomain) return null;

  // Canonicalise domain: strip leading @ if someone passes an address
  const domain = emailDomain.replace(/^@/, '').toLowerCase().trim();

  // Build company name hint from domain (strip TLD + "www")
  const domainBase = domain.replace(/^www\./, '').split('.')[0];

  const query = `"${name}" site:linkedin.com/in`;
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  log(`DDG search: ${query}`);

  try {
    const res = await fetchWithRetry(url, {
      headers: { 'Accept': 'text/html' },
    });
    if (!res) return null;
    if (!res.ok) {
      log(`DDG search returned ${res.status}`);
      return null;
    }

    const html = await res.text();

    // Parse all result links — DDG HTML wraps them in <a class="result__a" href="...">
    const linkedinUrls = [];
    const linkRe = /href=["'](https?:\/\/(?:www\.)?linkedin\.com\/in\/[^"'?#\s]+)/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const candidate = m[1].split('?')[0].replace(/\/$/, '');
      if (!linkedinUrls.includes(candidate)) linkedinUrls.push(candidate);
    }

    // DuckDuckGo sometimes wraps links through a redirect; extract real URL from uddg= param
    const redirectRe = /href=["'][^"']*[?&]uddg=(https?%3A%2F%2F(?:www\.)?linkedin\.com%2Fin%2F[^"'&\s]+)/gi;
    while ((m = redirectRe.exec(html)) !== null) {
      try {
        const candidate = decodeURIComponent(m[1]).split('?')[0].replace(/\/$/, '');
        if (!linkedinUrls.includes(candidate)) linkedinUrls.push(candidate);
      } catch { /* malformed encoding — skip */ }
    }

    log(`found ${linkedinUrls.length} LinkedIn URLs in DDG results`);

    if (linkedinUrls.length === 0) return null;

    // Score each candidate — prefer those whose snippet text contains the domain
    // Extract snippets text from DDG result block for scoring
    const snippets = [];
    const snippetRe = /<a[^>]+class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = snippetRe.exec(html)) !== null) {
      snippets.push(m[1].replace(/<[^>]+>/g, ' ').toLowerCase());
    }
    const allSnippetText = snippets.join(' ');

    // Try each URL; jitter between fetches, match on domain
    for (let i = 0; i < Math.min(linkedinUrls.length, 3); i++) {
      if (i > 0) await sleep(jitterMs());

      const profile = await fetchLinkedInProfile(linkedinUrls[i]);
      if (!profile) continue;

      const profileText = `${profile.headline} ${profile.employer}`.toLowerCase();
      const domainMatch =
        profileText.includes(domain) ||
        profileText.includes(domainBase) ||
        allSnippetText.includes(domainBase);

      if (domainMatch) {
        log(`matched profile for "${name}" @ ${domain}: ${linkedinUrls[i]}`);
        return profile;
      }

      log(`profile ${linkedinUrls[i]} did not match domain ${domain} — skipping`);
    }

    // If no domain match but only one result exists, return it as best-effort
    if (linkedinUrls.length === 1) {
      log(`no domain match but only one result — returning best-effort for "${name}"`);
      return fetchLinkedInProfile(linkedinUrls[0]);
    }

    log(`no confident match found for "${name}" @ ${domain}`);
    return null;
  } catch (err) {
    log(`search error for "${name}": ${err.message}`);
    return null;
  }
}

/**
 * Look up a person from the DB, find their LinkedIn profile by email domain
 * disambiguation, and write linkedin_url back.
 *
 * Sources for domain (in priority order):
 *   1. people.work_email_domain
 *   2. person_professional.company_domain
 *   3. Primary work email domain from person_identifiers
 *
 * @param {string} personId
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{updated:boolean,profile:object|null}>}
 */
export async function enrichPersonFromLinkedIn(personId, db) {
  if (!personId || !db) return { updated: false, profile: null };

  try {
    // Fetch person record
    const person = db.prepare(
      'SELECT id, display_name, linkedin_url, work_email_domain FROM people WHERE id = ?'
    ).get(personId);

    if (!person) {
      log(`person not found: ${personId}`);
      return { updated: false, profile: null };
    }

    // Already enriched — skip (caller can pass force:true via a wrapper if needed)
    if (person.linkedin_url) {
      log(`${person.display_name} already has linkedin_url — skipping`);
      return { updated: false, profile: null };
    }

    // Resolve email domain
    let emailDomain = person.work_email_domain || null;

    if (!emailDomain) {
      const pp = db.prepare(
        'SELECT company_domain FROM person_professional WHERE person_id = ?'
      ).get(personId);
      emailDomain = pp?.company_domain || null;
    }

    if (!emailDomain) {
      // Derive from primary work email in person_identifiers
      const identifier = db.prepare(`
        SELECT value FROM person_identifiers
        WHERE person_id = ? AND type = 'email'
        ORDER BY is_primary DESC LIMIT 1
      `).get(personId);

      if (identifier?.value && identifier.value.includes('@')) {
        const rawDomain = identifier.value.split('@')[1].toLowerCase();
        // Skip freemail — not useful for disambiguation
        const FREEMAIL = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com',
          'icloud.com','me.com','mac.com','aol.com','protonmail.com','live.com']);
        if (!FREEMAIL.has(rawDomain)) emailDomain = rawDomain;
      }
    }

    if (!emailDomain) {
      log(`no work email domain for ${person.display_name} (${personId}) — cannot search`);
      return { updated: false, profile: null };
    }

    log(`enriching ${person.display_name} using domain ${emailDomain}`);

    // Jitter before hitting LinkedIn
    await sleep(jitterMs());

    const profile = await searchLinkedInByEmailDomain(person.display_name, emailDomain);
    if (!profile) {
      log(`no LinkedIn profile found for ${person.display_name}`);
      return { updated: false, profile: null };
    }

    // Write back to people table
    db.prepare(`
      UPDATE people SET linkedin_url = ?, updated_at = datetime('now') WHERE id = ?
    `).run(profile.linkedinUrl, personId);

    // Also upsert into person_professional if available
    try {
      const exists = db.prepare('SELECT 1 FROM person_professional WHERE person_id = ?').get(personId);
      if (exists) {
        db.prepare(`
          UPDATE person_professional
          SET linkedin_url = ?, updated_at = datetime('now')
          WHERE person_id = ?
        `).run(profile.linkedinUrl, personId);
      } else {
        db.prepare(`
          INSERT INTO person_professional (person_id, linkedin_url, source, confidence, extracted_at)
          VALUES (?, ?, 'linkedin-scraper', 0.8, datetime('now'))
        `).run(personId, profile.linkedinUrl);
      }
    } catch (ppErr) {
      // person_professional upsert failure is non-fatal
      log(`person_professional upsert warning: ${ppErr.message}`);
    }

    log(`updated ${person.display_name} → ${profile.linkedinUrl}`);
    return { updated: true, profile };
  } catch (err) {
    log(`enrichPersonFromLinkedIn error (${personId}): ${err.message}`);
    return { updated: false, profile: null };
  }
}
