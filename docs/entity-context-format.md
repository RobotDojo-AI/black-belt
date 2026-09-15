# Entity Context Format

Canonical format for person, place, and company context files used throughout
the entity pipeline and served to the AI as context.

## Density standard

Content density over visual formatting. Every line carries information. No
markdown tables — tables waste chars on pipes and alignment with no benefit
in context. Use structured prose or key-value pairs.

## Person files

key-value header followed by prose notes:

```
name: Full Name
role: Current title or function
relationship: how Owner knows this person (colleague, friend, family, etc.)
tier: N1/N2/N3 network tier
last_contact: YYYY-MM-DD
```

Prose notes below the header: significant interactions, shared projects, context
the AI needs to give useful answers about this person. One paragraph max per topic.

## Place files

```
name: Place Name
type: city/venue/neighborhood/region
significance: why this place matters in Owner's life
```

Prose: visits, associations, relevant history.

## Company files

```
name: Company Name
type: employer/client/vendor/portfolio
relevance: Owner's relationship to this company
```

Prose: history, key contacts, context for the AI.

## Rules

- No markdown tables in context files
- Section headers (##, ###) only when delimiting genuinely distinct information types
- Structured prose preferred over bullet lists for narrative content
- key-value pairs for structured facts that the AI might query directly
- Keep files under 2K chars — dense, not comprehensive
