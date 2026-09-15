# Robot Dojo - Claude Code Adapter

This file is an adapter for Claude Code. It is not the project constitution. The canonical project surfaces are:

1. `architecture/product.md` - product promise, launch scope, tier model
2. `architecture/architecture.md` - human-readable system architecture
3. `architecture/structure.md` - repository placement contract
4. `architecture/sitemap.md` - generated file inventory
5. `architecture/ontology.md` - generated directory ontology
6. `agents/agents.md` - agent roster and routing; per-agent canonical bodies in `agents/personas/{Name}.md`; generated adapters in `agents/dist/`
7. `agents/build-conventions.md` - build conventions
8. `user/workbenches/topics/work/robot-dojo/wk_robot_dojo/kanban.md` - current work state

Read those before making product or architecture changes.

## Product Truth

Robot Dojo is a local-first personal intelligence substrate. Chat is the hero. Context is the product.

White Belt knows the user: sync, imports, RAG, timeline, topic context, user context, and chat.

Black Belt knows the user's world: White plus entity extraction, enrichment, entity context files, relationship/world context, and entity-aware chat.

If Black Belt expires, delete or disable only derived Black Belt assets. Preserve raw source data, White Belt sync, White Belt RAG, topic context, user context, account config, and enough metadata to regenerate Black Belt if the user resubscribes.

## Agent Invocation

Use natural language if slash commands are not available. These map to the live build pipeline:

- story or defect intake
- framing
- research
- scope
- plan
- build
- qa
- close

`/work` is exploratory only. Retros and generalization are not part of the live loop. Bunshin is a mandatory QC gate for research, scope, plan, build, and QA stages. Close uses Bunshin only when it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims. Miyagi self-audit is not Bunshin approval.

The owner advances stages. A stage writes one artifact, seals it, and stops.

## Specialist Rule

Every spawned specialist must read `architecture/sitemap.md` and `architecture/ontology.md` first, then inspect the concrete files in scope.

Do not add root `AGENTS.md`. The root structure gate rejects uppercase root markdown and this repo uses `CLAUDE.md` only as the Claude Code adapter.

## Canonical Docs Rule

Canonical docs should distill signal. Do not append historical chat debris or every implementation detail.

- Product truth goes in `architecture/product.md`.
- System shape goes in `architecture/architecture.md`.
- File placement rules go in `config/root-allowlist.lock.json`; `architecture/structure.md`, `architecture/ontology.md`, and gate scripts derive from or enforce that lock. Protected architecture changes need non-repo owner approval locally and CODEOWNERS review on GitHub.
- Current work state goes in `user/workbenches/topics/work/robot-dojo/wk_robot_dojo/kanban.md`.
- File inventory belongs in generated `architecture/sitemap.md`.
- Directory ontology belongs in generated `architecture/ontology.md`.

Generated inventory docs follow code and config. Human canonical docs guide future code.

## Build Conventions

Follow `agents/build-conventions.md`.

Important local rules:

- Use existing patterns before adding new abstractions.
- Do not resurrect removed product surfaces.
- Do not reintroduce implicit approvals, with exactly one exception: invoking the exact correct next stage skill (i.e., the skill whose immediate predecessor is the currently-pending sealed stage) counts as an owner countersign for that predecessor — run --approve <predecessor> automatically before the invoked skill proceeds. Any wrong-stage or multi-stage-skip invocation still halts via the normal --require block. Word-only signals {yes, y, proceed, go, go ahead, approved, ok} also count as a countersign for the pending sealed stage; run `node ~/robotdojo/scripts/story-gate.js --approve-pending --story <id>` when the story is known, or `--approve-pending` only when exactly one active record is pending. All other implicit paths remain forbidden.
- Do not make Claude-only behavior the product architecture.
- Keep docs short enough to remain useful.
- Use `rg` for search.
- Use `apply_patch` for manual edits.
- Never revert user changes unless explicitly asked.

## Memory Protocol

**Override:** The Claude Code global auto-memory system at `~/.claude/projects/-Users-miyagi/memory/` is disabled for this project. Do not write there.

All memory writes use `~/robotdojo/user/memory/bin/memory-append.js`:
```bash
node ~/robotdojo/user/memory/bin/memory-append.js \
  --type feedback|user|project|reference \
  --name slug \
  --description "one line" \
  --author miyagi \
  --body "body text"
```

Log lives at `~/robotdojo/user/memory/log/`. Search: `node ~/robotdojo/scripts/memory-search.js <keyword>`. Write without asking permission.

## Data Boundaries

Raw personal data stays local and is not committed.

Gitignored data zones include local databases, generated contexts, imports, logs, media, memory, transcripts, user files, and pipeline story artifacts.

Agent or script writes to production data must go through the intended application path. Do not patch corrupted data with one-off writes unless the owner explicitly approves a repair plan.

## Checks

Use focused checks while working. Run broader checks before ship when the environment is ready.

Useful focused checks:

```bash
node --test tests/story-preflight.test.js tests/story-pipeline.test.js
node scripts/generate-sitemap.js --check
node scripts/generate-ontology.js --check
node scripts/check-canonical-mode.js
node scripts/check-doc-budget.js
```

Regenerate generated docs after structural edits:

```bash
node scripts/generate-sitemap.js --write
node scripts/generate-ontology.js --write
```

Full `npm test` may require local services, credentials, and writable OS services. If it fails on environment-only checks, report that separately from product regressions.
