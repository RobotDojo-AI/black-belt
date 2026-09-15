# Entity Research Home

Deep company or person research belongs in the entity's canonical home, not
loose inside whatever topic or career workbench happens to be open.

## The canonical home

- Entity context file: `user/contexts/{people|companies|places}/{display-slug}--{stable-id-suffix}/context.md`.
- Entity workbench: `entityWorkbenchRoot()` (`lib/workbenches.js`) →
  `user/workbenches/entities/{people|companies|places}/{owner}/wk_.../`.
- Promotion to the graph: `/profile <name> <url>` creates the entity if
  needed and writes `## Summary`, `## About`, `## Relationship` to its
  context file (st_483361e2).

## The anti-pattern

A loose file named for a company or person, dropped under a topic or career
workbench's `substrate/research/` directory — e.g.
`user/workbenches/topics/work/career/wk_.../substrate/research/2026-07-19-acme-fit/acme.md`.
That research is unprovenanced, isn't reusable from any other topic that
touches the same entity, and duplicates what `/profile` would produce for
the same name.

## The rule

A topic or career workbench REFERENCES an entity — a link to its context
file, a note on why it matters to this topic — it never embeds a company or
person profile copy. Deep entity research runs through `/profile` and lands
at the entity's canonical home; the topic workbench points at it.

## The guard

`scripts/check-entity-research-home.js` flags research files under
`user/workbenches/topics/**/substrate/research/**` whose name matches a
company or person already in the graph — the concrete signal that a loose
file duplicates a home that already exists. Report-only: it never blocks a
commit, because a name match can be wrong and a false positive here (a real
topic analysis mistaken for an entity profile) is worse than a missed loose
file. Run it manually — `node scripts/check-entity-research-home.js` — or
read its output when it flags something mid-session; the fix is `/profile
<entity> <url>`, then point the topic workbench at the resulting context
file instead of keeping its own copy.

If the entity doesn't exist in the graph yet, the guard has nothing to match
against and stays silent — that is correct, not a guard bug. `/profile`
creates the entity; run it before or after the loose file is written and the
guard picks up the match on the next run.
