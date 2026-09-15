---
name: followup
description: Post-call synthesis sweep — finds transcript, emails, and SMS for a named person or company, synthesises call notes, updates their Asana card, creates entities, and populates subtasks.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
  - user/workbenches/user/wk_user/user-voice/formatting/asana.md
type: tool
---

# /followup
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->

Post-call synthesis sweep. Invoke as `/followup <entity> <instructions>`.

## Canonical use cases

- Post-call synthesis for a person or company you just met with.
- Updating an Asana card with a call summary, entity links, and follow-up subtasks after a Granola sync.
- Researching a new person or company mentioned during a call, with the result written to both their context file and the caller's Asana card.

## Contract

Reads: the live DB (`people`, `companies`, `person_identifiers`, `transcripts`, `emails`, `imessages`), the Asana People or Companies board via API, and `user/workbenches/user/wk_user/user-voice/formatting/asana.md` for the description format.

Writes: the named entity's Asana board milestone card (formatted `html_notes` + subtasks), Robot Dojo people/company entities for everyone mentioned in instructions, and a deep research profile to each entity's context file.

Stops when: `runFollowupSweep` returns, its result is reported to the owner, and any test residue is removed. Reports the reason and stops without fabricating synthesis when no transcript is found.

## Invocation

```
/followup <entity> <instructions>
```

- `<entity>` — the person or company you are following up with. Resolves against the entity graph and the corresponding Asana board (People for persons, Companies for companies).
- `<instructions>` — what you want the sweep to do. Name any people or companies to research, each with a canonical identifying URL. Explicitly state the entity type when a URL is ambiguous ("is a person", "not a company").

**Canonical URL types:**

| Entity type | Preferred | Also accepted |
|-------------|-----------|---------------|
| Person | `linkedin.com/in/…` | Company bio page, personal website |
| Company | `linkedin.com/company/…`, `crunchbase.com/organization/…` | Company website |

As long as the entity-URL pairing is clear in the instructions, the URL type does not have to match perfectly.

Examples:
- `/followup person-a razib khan intro www.razibkhan.com — person, blogger`
- `/followup company-a follow up on partnership; person-b linkedin.com/in/person-b is their BD lead`
- `/followup person-c discussed podcast collab and intro to company-a https://company-a.com`

## Steps

1. **Parse entity and type.** Extract the primary entity name from the first argument. Infer type (person/company) from context — default to person.
2. **Resolve the entity.** Look up in `people` (person) or `companies` (company) table. If not found, report and stop.
3. **Call `runFollowupSweep`.** Import `{ runFollowupSweep }` from `lib/followup-sweep.js`. Pass `db` and `opts = { entityName, entityType, instructions }`.
4. **Handle the result.**
   - If `result.skipped === true`: report `result.reason` and stop.
   - Otherwise: report what was updated.
5. **Report to the owner.** Keep it short: transcript found (title + date), entities created (count + names), Asana card (GID or "not updated" if PAT missing), subtasks created (count).

## What runFollowupSweep does

- Finds the most recent Granola transcript for the entity (person: by attendee email then title; company: by attendee emails from linked people).
- Reads the attributed transcript file from disk (speaker-named lines) rather than the stripped DB column.
- Pulls the last 10 inbound emails and iMessage frequency (person) or emails from linked people (company).
- Synthesises call notes via Haiku.
- Extracts entities named in instructions with their canonical URLs and explicit type hints.
- Creates/resolves each entity in Robot Dojo, respecting owner-stated type over URL inference.
- Runs /profile for each entity with a source URL.
- Looks up or creates the entity's Asana card (People board for persons, Companies board for companies).
- Writes formatted `html_notes` to the Asana card.
- Extracts follow-up commitments; creates named subtasks or a single next-day review task.

## Return shape

```js
{
  entityId: string,        // people.id or companies.id
  transcriptId: string,    // transcripts.id used
  asanaGid: string|null,   // Asana task GID
  subtasksCreated: number,
  entitiesCreated: number,
  entityIds: string[],
  contextFiles: string[],  // relative paths to entity context files written
}
// OR:
{ skipped: true, reason: string }
```

## Voice register

See `user/workbenches/user/wk_user/user-voice/formatting/asana.md` for the Asana description format.
All Asana html_notes use: `body`, `strong`, `a[href]`, `ul`, `li` — no `p`, no `br`.

## Out of scope

- Relay URL as default — links use `localhost:4338`. Relay-as-default is a follow-on story.
- Raw iMessage text — frequency only (count/date), not message content.
- Multi-source triggers — auto-fires on Granola sync only. Email and calendar triggers are future.
