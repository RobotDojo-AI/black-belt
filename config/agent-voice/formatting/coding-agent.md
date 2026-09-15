# Agent voice — Claude Code channel (format delta)
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->

How every agent — sub-agents and the main Claude Code session — shapes a response for the user.

## Shape

Leading prose. Visual breaks between idea groups. Max 2 bullet levels.

Enumeration only when a point-by-point reply is needed — bullets or `-` dashes otherwise. Bold only for structural labels (navigation), never for emphasis.

Closing action at the end if a decision is needed. Otherwise stop when done.

## Artifacts

Print the artifact in the reply. Voice files, drafts, diffs, the decision. A path is not the answer.

## Commands to copy

One fence, one single-line command, nothing else in it. No `!` prefix. Explain before the fence, never inside.

## Stage Approval Prompts

Research, scope, plan, build, and QA approval prompts are owner-facing decision blocks. Use the existing worked-example shape, only shorter. Do not replace it with a form.

Hard limits:

- Max 18 meaningful lines.
- Start with a one-paragraph plain-English summary.
- Use numbered items as `1)` when the owner needs point-by-point approval.
- Use lettered subpoints as `a)` only when a parent item needs separate owner feedback.
- End with a conclusion or decision line, then a next-step line.
- Do not use `[PASS]` / `[FAIL]` status-table styling in owner-facing prose.
- Technical proof belongs in the artifact, not in the lead summary.

Required shape:

1) Summary paragraph
2) Numbered owner-relevant items, only if useful
3) Conclusion / decision needed
4) Next step

Template:

```text
{Short plain-English summary.}

1) {Owner-relevant item}
2) {Owner-relevant item}
3) {Owner-relevant item}

{Decision needed or conclusion.}

Next step is {stage/action}.
```

Technical verification must not lead the owner-facing block. A prompt that starts with tests, hashes, commands, criteria counts, implementation files, or "technical verification" fails the contract even if the artifact is correct.

## Numbering verdict (house rule)

The one numbering form — every owner-facing block, every persona, and every render-summary skill follows it, and the stage-presentation gate enforces it.

- Numeric parent: `1)` `2)` `3)` — a closing paren, never a period (`1.`).
- Alpha child: `a)` `b)` `c)` — indented one level under its parent, a closing paren, never a period (`a.`).
- Never letter-first parents (never a1, never a2). The parent is always a number.
- Two levels maximum. Number the top, letter the child, stop. Enumerate only when the owner replies point-by-point; otherwise plain `-` dashes.
- Bold only for structural labels (e.g. `**Summary**`), never for emphasis. Blank line between idea groups. No closing pleasantries — the final line is the next action or last fact.

Worked example of the exact form (AC before OOS; lettered children only when a parent needs its own feedback):

```text
Scope drafted for st_xxxx. 3 ACs, 1 OOS.

1) First owner-relevant point
    a) A sub-point that needs its own owner feedback
    b) Another sub-point
2) Second owner-relevant point
3) Third owner-relevant point

Decision needed: approve the 3 ACs.
Next step is /plan.
```
