# Topic substrate (coding agent)

There is no workbench product. Topics are the unit. Chat is the standing conversation on a topic. The coding agent works the same topic with extra tools. This file is the operator contract for that coding-agent open path — not a customer surface.

## Operator Contract
When the owner or a Black Belt user asks a coding agent for a topic, person, company, or place, run:

```bash
node scripts/workbench-open.js --target "<target>"
```

That command must:
- resolve an existing topic substrate or create the default one;
- attach it to exactly one primary topic/entity plus optional related targets;
- write or refresh the resume `INDEX.md`;
- write or refresh the distillation contract;
- index substrate into `workbench_items`;
- write topic chunks into RAG with `skip_embed=0` by default;
- return a no-rehydration resume payload with current question, latest state, next action, distillation contract, minimum boot, deep links, related entities, and canonical promotion targets.

## How To Open A Topic
The operator asks a coding agent for the topic, person, company, or place:

```text
/topic career
/topic health
/topic Airbnb
```

The coding agent runs `workbench-open`, reads the returned root and `INDEX.md`, then works inside that private topic folder. The user does not need to know the path.

The coding agent writes durable outputs into the topic: notes, analyses, charts, and small apps. Those become product surfaces only after promotion, scrub, packaging, and registry entry.

Before major research or build work, the agent states the distillation contract in one short pass and lets the user correct it:

- Purpose: what the topic session is trying to make possible.
- Canonical target: which topic/entity `context.md` files receive durable truth.
- Compact context: what is short enough and stable enough to promote into chat context.
- Long synthesis: what stays uncapped inside the topic folder.
- RAG substrate: what source files, notes, datasets, renderings, histories, todos, and decisions are indexed.
- Review threshold: what the agent may update directly and what requires explicit approval before promotion.

Default rule: working notes and substrate can be written directly; compact canonical truth requires reviewed wording.

## Storage Rule
Workbench roots live under the top-level private-data root:

```text
user/workbenches/topics/{t1}/{t2}/{workbench_id}/
user/workbenches/topics/{t1}/{workbench_id}/
user/workbenches/entities/{people|companies|places}/{entity-package}/{workbench_id}/
```

`user/contexts/**/context.md` remains the compact canonical memory target. Topic folders hold deep private substrate.

Reusable application code stays outside workbenches in `apps/`, `lib/`, and `routes/`. A workbench can hold app instance data, generated views, dashboards, manifests, and private analysis, but reusable chart/wiki/dashboard components belong in product code so future topic apps can share them without embedding private data.

Raw owner-supplied evidence stays in `user/files/`, `user/transcripts/`, `user/databases/`, or another approved source root unless the topic folder needs a derived copy. Topic folders cite evidence, transform it, and preserve the working set.

Customer release builds ship workbench scaffolding and templates, not the founder's private workbenches. Owner/developer discovery seeds are available only in owner mode or explicit tests.

## Memory Rule

Every default topic folder has:

- `INDEX.md` — rewritten compact resume state with Now, Next, Waiting, Done Recently, and Open Loops.
- `LOG.md` — append-only operational memory.
- `SYNTHESIS.md` — deep topic-level distillation, longer than canonical context.

## Promotion Rule
Topic substrate is not final truth. Durable conclusions promote into the owning `context.md` for the topic or entity. Long synthesis can remain inside the topic folder; compact canonical truth must move to `context.md` so chat and RAG improve.

Promotion participates in the background maintenance system:

- reviewed promotion writes compact context or facts;
- the target topic/entity is marked dirty;
- a maintenance queue row records the refresh reason;
- context regeneration rewrites compact truth instead of appending raw notes forever.

## Migration Rule
Historical cleanup can be manual once. Future work must enter through `workbench-open`, `workbench-discover`, `workbench-index`, and `workbench-promote`.
