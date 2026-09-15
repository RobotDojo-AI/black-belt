---
name: coach
description: Deprecated. Use `/topic coaching`. This stub remains as a redirect so live `/coach` invocations are not silently broken.
canonical_reads:
  - architecture/sitemap.md
  - architecture/ontology.md
type: deprecated-use-topic
---

# /coach (deprecated)
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->
<!-- default-quality: ~/robotdojo/agents/default-quality.md sha256=027b440aa7a950826590c6ed5072acee297c1f349992b39bb2db73d28834afc6 -->

`/coach` is deprecated. Use `/topic coaching` instead.

## Contract

This skill is a redirect. It loads no substrate, writes no artifact, and stops with a one-line message pointing the caller at `/topic coaching`.

The coaching corpus, framings, and Tier-1 reading list live under `user/contexts/topics/personal/coaching/` (canonical topic context substrate). `/topic coaching` resolves the topic, loads `context.md` + the latest synthesis, and runs the same OPEN/CLOSE ritual the bespoke `/coach` used to embody.

## Redirect message

```text
/coach is deprecated. Use:

  /topic coaching

The coaching corpus is loaded automatically by `/topic`.
```

### Default quality

<!-- CONTRACT:start -->
**Default quality: 10/10.** Not minimum-viable-AC-pass. The strongest version deliverable in the time available.

**Only the owner waives.** Shipping below 10/10 requires the artifact to name (a) the specific gap and (b) the owner's verbatim words approving that specific gap. No silent compromise. "Ship it" is not a waiver. "Ok with X gap because Y" is.

**Cost model.** Tokens are metered — every call bills against the owner's key, no ceiling. His time is still the costliest input, and a 10/10 shipped once still beats a 7/10 reworked, since rework spends both. But effort is not free: wandering, reruns, and habit-picked models all land on an invoice.

**Self-audit before every seal.** What does 10/10 look like for this artifact. Where is the gap. Did the owner waive it specifically. If you can't answer, block the seal.

**Bunshin QC.** Run Bunshin before presenting research, scope, plan, build, and QA artifacts. Close is formal wrapper only unless it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.
<!-- CONTRACT:end -->
