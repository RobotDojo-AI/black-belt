# Profile Schema

Canonical contract for entity context files written by `lib/profile-research.js` and the `/profile` skill.

## Sections

Every entity context file (person or company) may have three Robot Dojo-owned sections. The `/profile` skill and `runFollowupSweep` write exactly these sections; all other sections are preserved byte-for-byte.

### Person: ## Summary

Key-value block. 1K budget.

```
## Summary
company: <current employer>
current_role: <title or headline>
location: <city, region>
linkedin_url: <https://linkedin.com/in/...>
twitter: <@handle or empty>
```

### Person: ## About

Sonnet-synthesised factual profile. 4K budget. Third person, declarative, no hedging, no outreach language. Sources: LinkedIn ld+json + Brave fan-out (4–5 queries, top 2 non-LinkedIn URLs fetched per query).

### Person: ## Relationship

Stub generated from DB reads. 4K budget. Updated on each `/profile` or followup-sweep run.

```
Key dynamic: [unknown until more meetings]. Last connected: <date> via <channel>. Email frequency: <n> recorded.
```

---

### Company: ## Summary

Key-value block. 1K budget.

```
## Summary
description: <one-line company description>
website: <https://...>
funding_stage: <Series A / Seed / etc.>
total_raised: <$XM or unknown>
lead_investors: <Firm A, Firm B>
employee_range: <1-10 / 11-50 / etc.>
```

### Company: ## About

Sonnet-synthesised factual profile. 4K budget. Sources: Crunchbase ng-state + Brave fan-out (4–5 queries, top 1 non-Crunchbase URL per query).

### Company: ## Relationship

Stub generated from DB reads. 4K budget.

```
Context: <hint from call>. Key contacts: <display_name>. Last interaction: <date>.
```

---

## Section Ownership and Merge Rules

`mergeProfileSections(existingContent, sections)` applies these rules:

1. The three Robot Dojo sections (`## Summary`, `## About`, `## Relationship`) are replaced wholesale on every write.
2. All other sections in the file are preserved byte-for-byte.
3. YAML frontmatter (`---\n...\n---`) is updated by upserting keys from `sections.frontmatterPatch`. Existing frontmatter keys not in the patch are preserved.
4. Content integrity guard: if the merged result is shorter than 20% of the original file, log a warning and return the original unchanged.
5. On a fresh file (no existing content): produce frontmatter + `## Summary` + `## About` + `## Relationship` stub.

---

## YAML Frontmatter Fields

### Person

| Field | Written by |
|-------|-----------|
| `linkedin_url` | `/profile` skill (Playwright extract) |
| `web_refreshed_at` | every profile-research write |

### Company

| Field | Written by |
|-------|-----------|
| `crunchbase_url` | `/profile` skill (Playwright extract) |
| `website` | researchCompany |
| `web_refreshed_at` | every profile-research write |

---

## Budget Mode

No per-file character cap is enforced by this module. Chat slices context at:
- 1K characters for `## Summary`
- 4K characters for `## About` and `## Relationship`

The 1K/4K limits apply to how chat RAG slices the sections, not to what profile-research writes.

---

## Execution Paths

| Path | LinkedIn/Crunchbase | Brave | Sonnet |
|------|-------------------|-------|--------|
| `/profile` skill | Playwright MCP (caller extracts, passes `linkedinData`/`crunchbaseData`) | Yes | Yes |
| `followup-sweep` (auto-sync) | Brave-only (no Playwright available) | Yes | Yes |

The library functions (`researchPerson`, `researchCompany`) accept an optional `linkedinData` / `crunchbaseData` param. When null, the function skips the structured-data step and relies on Brave results alone.
