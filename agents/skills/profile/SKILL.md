---
name: profile
description: Deep research a person or company by URL, creating the entity if needed. Writes ## Summary, ## About, ## Relationship to the entity's context file.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
  - docs/profile-schema.md
type: tool
---

# /profile
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->

Deep research a person or company on demand. Takes a URL to disambiguate the name and finds or creates the entity.

## Canonical use cases

- Research a person or company before a meeting, call, or outreach.
- Create or update an entity's context file from a live web source (LinkedIn, Crunchbase, personal site).

## Contract

Reads: live DB (`people`, `companies`, `transcripts`, `emails`), the provided URL via Playwright (LinkedIn or Crunchbase).

Writes: `## Summary`, `## About`, and `## Relationship` sections to the entity's context file. All other sections are preserved byte-for-byte. `web_refreshed_at` is updated in YAML frontmatter.

Never: drafts outreach, suggests intro paths, or writes to the entity graph structure beyond the context file.

Stops when: context file is written and the owner is reported: entity name, type, created/updated, context file path, web_refreshed_at.

## Invocation

```
/profile <name> <url>
```

Examples:
- `/profile person-a https://linkedin.com/in/person-a`
- `/profile company-a https://crunchbase.com/organization/company-a`

## Steps

1. Parse args: extract name and URL from the invocation.

2. Resolve entity:
   ```js
   import { resolveEntityFromUrl } from '~/robotdojo/lib/profile-research.js';
   import db from '~/robotdojo/lib/db.js';
   const { entityId, entityType, created } = await resolveEntityFromUrl(url, name, db);
   ```

3. Extract structured data via Playwright MCP (before calling the library):

   For a **person** (linkedin.com/in/):
   - Use `mcp__playwright__browser_navigate` to navigate to the LinkedIn URL.
   - Use `mcp__playwright__browser_evaluate` with `document.querySelector('script[type="application/ld+json"]')?.textContent` to extract ld+json.
   - Parse JSON; pull `givenName`, `familyName`, `jobTitle` (headline), `alumniOf`, `description`.
   - DOM fallback if ld+json absent: evaluate `document.querySelector('h1')?.textContent?.trim()` for name, `document.querySelector('div.text-body-medium')?.textContent?.trim()` for headline.
   - Build `linkedinData = { name: resolvedName, headline, company, location, description }`.

   For a **company** (crunchbase.com/organization/ or linkedin.com/company/):
   - Use `mcp__playwright__browser_navigate` to navigate to the Crunchbase URL.
   - Use `mcp__playwright__browser_evaluate` with `document.querySelector('#ng-state')?.textContent` to extract ng-state JSON.
   - Parse JSON; pull `short_description`, `website_url`, `funding_stage`, `total_funding_amount_value`, `lead_investors`, `num_employees_enum`. Graceful degradation: missing fields → `'unknown'`.
   - Build `crunchbaseData = { short_description, website_url, funding_stage, total_raised, lead_investors, employee_range }`.

   For a **company (website URL — not linkedin.com or crunchbase.com)**:
   - Use `mcp__playwright__browser_navigate` to navigate to the URL.
   - Use `mcp__playwright__browser_evaluate` with `document.querySelector('script[type="application/ld+json"]')?.textContent` to extract ld+json.
   - Parse JSON; pull `description` field. Fallback: evaluate `document.querySelector('meta[name="description"]')?.content`.
   - Build `crunchbaseData = { short_description: description || 'unknown', website_url: url, funding_stage: 'unknown', total_raised: 'unknown', lead_investors: 'unknown', employee_range: 'unknown' }`.
   - If ld+json is absent or unparseable and meta description is absent, set `crunchbaseData = null` — `researchCompany` falls through to Brave-only synthesis.

4. Research (pass pre-fetched web data to avoid MCP dependency in library):
   ```js
   import { researchPerson, researchCompany } from '~/robotdojo/lib/profile-research.js';
   const sections = entityType === 'person'
     ? await researchPerson({ name, linkedinUrl: url, linkedinData, db, entityId })
     : await researchCompany({ name, crunchbaseUrl: url, crunchbaseData, db, entityId });
   ```

5. Read existing context file:
   ```js
   import { entityContextPath } from '~/robotdojo/lib/context-paths.js';
   import { resolve } from 'node:path';
   import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
   import { dirname } from 'node:path';
   const REPO_ROOT = process.env.ROBOTDOJO_HOME || `${process.env.HOME}/robotdojo`;
   const contextRelPath = entityContextPath(entityType, entityId, db);
   const absPath = resolve(REPO_ROOT, contextRelPath);
   const existingContent = existsSync(absPath) ? readFileSync(absPath, 'utf8') : null;
   ```

6. Merge and write:
   ```js
   import { mergeProfileSections } from '~/robotdojo/lib/profile-research.js';
   const merged = mergeProfileSections(existingContent, sections);
   mkdirSync(dirname(absPath), { recursive: true });
   writeFileSync(absPath, merged, 'utf8');
   ```

   Entity identity is deterministic: `resolveEntityFromUrl` dedupes a person by
   their LinkedIn URL (then exact name); a company by hostname in `company_domains`
   (website URLs only), then by name-LIKE across all company types. Re-running
   `/profile` on the same URL updates the same entity and writes the same file —
   it never creates a duplicate. Callers (e.g. followup-sweep) resolve the same
   way and verify the written file on disk; they do not parse this skill's prose.

7. Report to owner:
   - Entity: `${name}` (${entityType}, ${created ? 'created' : 'updated'})
   - Context file: `${contextRelPath}`
   - Refreshed: `${sections.frontmatterPatch.web_refreshed_at}`

## Required output depth

A passing `## About` section for a **person** must cover all six sections with substantive content (not "unknown" or placeholder text):

- **Current Role** — what they do and where, including publication/company/platform name
- **Known For** — specific domain, signature ideas, key intellectual positions, or most notable work
- **Background** — education and career history
- **Work & Output** — named books, essays, research, podcasts, or projects
- **Reach** — audience size, platform, notable press, key collaborators
- **Recent Activity** — what they are working on or have done recently

Thin output (generic role description + location + "recent activity" only) does not meet the bar. A writer or intellectual without LinkedIn must be researched via Brave queries targeting their specific domain and published work, not just their website's meta description. The six-section structure is enforced by the synthesis prompt in `lib/profile-research.js` — do not regress it.

A passing `## About` section for a **company** must cover: what the company does, market position, funding stage, key people, and recent news.

## Constraints

- No outreach drafts. No warm-intro suggestions. Research surfaces what's known; the network product owns that layer.
- No SQL in this skill file. All logic in `lib/profile-research.js`.
- After `/profile` runs, confirm `web_refreshed_at` in the context file frontmatter is updated.
