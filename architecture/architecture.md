# Robot Dojo Architecture

Robot Dojo is a local-first personal intelligence substrate. Chat is the hero. Context is the product. Context is already all around the user: chats, email, calendar, documents, texts, health data, contacts, projects, and history. Robot Dojo makes that context usable.

This file is the human-readable architecture. It should stay short enough to power onboarding copy and agent orientation. Implementation details belong in `architecture/sitemap.md`, `architecture/ontology.md`, `architecture/structure.md`, source code, tests, and story artifacts. Placement contracts and doc-class homes live in `architecture/structure.md`.

## System shape

Robot Dojo is a single local server (a Hono process on the user's Mac) plus a relay for optional remote access. There is no cloud business logic. The user's data lives in `~/robotdojo/user/`, the product code lives in `~/robotdojo/{lib,routes,apps,scripts,agents}/`, and the public surface lives at `~/robotdojo/api/` (Vercel edge functions) and `~/robotdojo/apps/` (browser HTML).

The product layers:

1. **Install and access.** macOS-only on Apple Silicon. The app runs on the user's Mac and is reachable locally. A relay at `robotdojo.ai` is optional remote access — not cloud hosting, not a VPN, not required for local use.
2. **Account connections and imports.** The user connects email, calendar, SMS/iMessage, chat exports, files, and health or domain data where available, plus foundation model session exports.
3. **Local data plane.** Raw personal data stays local. User data is never stored on Robot Dojo's servers as part of the core product. Product intelligence and user identity are separate.
4. **RAG and timeline.** Useful source material is embedded, scored, filtered, and tagged. Low-quality or stale material is suppressed. Background indexing throttles itself.
5. **User and topic context.** A user-editable `user/workbenches/user/wk_user/` vessel (chat-injected distillation + deep companion) plus topic and entity context files synthesized over time.
6. **Black Belt world model.** Entity extraction, enrichment, context files, and world-aware chat. People, places, and companies become first-class surfaces.
7. **Chat runtime.** Chat loads user context, selected topic context, relevant RAG, and any matched entity context. Topic selection uses a registry lookup, not an LLM on the critical path.
8. **Apps on the substrate.** Health is the first first-party premium app. Future apps ship through the app registry/package contract.
9. **Build system.** Skills and pipeline stages are reusable build protocols. Customer-facing build skills are not chat commands.
10. **Backup boundary.** Product code in source control; private local state in GCP-backed backup; no hidden third place.

Internally, chat is the hero. The framing is that everything else feeds the chat experience or is consumed by it. The visual north star is fast, polished, and quiet.

## Data flow

Robot Dojo improves by repeatedly distilling source material into cleaner context:

1. Ingest raw records.
2. Normalize and deduplicate.
3. Score and filter.
4. Tag by topic.
5. Update timeline and user-level context.
6. In Black Belt, extract and enrich entities.
7. Generate or refresh context docs.
8. Use those docs in chat.
9. Let the user's corrections feed the next pass.

This is the same pattern behind health and coaching. Chat grows the corpus laterally. Focused topic sessions in the coding agent grow it vertically by adding framing, decisions, and reusable mental models.

The architectural promise:

- It keeps syncing from the user's connected accounts.
- It filters weak source material instead of hoarding noise.
- It weights recent knowledge because people change.
- It improves topic context while the user chats and while the user is away.
- It recognizes entities and context as the user chats.
- It lets the user correct identity, agents, topics, and important context directly.

## Agent OS

The build pipeline is a six-agent system, isolated context windows, persona-bound briefs.

- **Miyagi (宮城)** — orchestrator + thinking partner. Always running. Routes work, enforces gates via story-gate.js, talks to the owner.
- **Tantei (探偵)** — codebase mapper. Spawned when a story touches code that needs a map.
- **Hakase (博士)** — external researcher. Spawned when a story needs knowledge outside the codebase.
- **Ori (織)** — schema + design architect. Spawned when a story is multi-phase or needs schema/API design.
- **Katagami (型紙)** — builder. Spawned after the plan is sealed.
- **Bunshin (分身)** — mandatory stage QC auditor. Runs before research, scope, plan, build, and QA artifacts are presented. Close uses Bunshin only when it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims.

The pipeline stages are fixed: framing → research → scope → plan → build → qa → close. Every stage writes one artifact under `user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/{id}/`, seals it, and stops for explicit owner approval. The single hop after a seal is the only implicit-approval exception; everything else is owner-driven.

The skill set is portable. Skills, personas, and pipeline stages are protocols. They are designed to be carried across IDEs (Claude Code, Codex, Cursor) — the canonical sources live in `agents/personas/*.md` and `agents/skills/*/SKILL.md`, and tool-specific adapters in `agents/dist/` are disposable generated outputs.

Topic-bound exploratory work runs through the universal `/topic {name}` opener — one OPEN/CLOSE ritual for every topic or entity. Bespoke `/coach` and `/health` are deprecated stubs that redirect to `/topic coaching` and `/topic health`. `/work {name}` is the same command.

The system is built to be portable across future AI stacks. The owner-facing decision points (each stage seal, each Bunshin verdict, each implicit-approval boundary) are protocol-level, not Claude-specific.

## Tier enforcement

White Belt is MIT-licensed open source. The code is public; anyone can audit, fork, and run it.

Black Belt is source-available under the Elastic License v2 (ELv2). The code is public so users can audit what they run. Running Black Belt requires an active subscription — the relay (remote access) is the hard server-side gate, not a client-side check. Subscription state lives server-side and is not crackable from the client.

If Black Belt expires:

- Engines pause: entity extraction and enrichment jobs, entity-aware chat injection, coding-agent skills on topics, Health and premium app execution, premium agent/tool runs.
- Data is preserved read-only: raw files, local databases, chat history, topics, topic logs and outputs, user-created files/apps, account settings, and existing entity markdowns stay on the machine.
- Reactivation restores active use.

User raw data is never encrypted by Robot Dojo. It stays the user's, in plain SQLite under `~/robotdojo/user/databases/` (default) with optional encryption gates documented in build conventions.

The tier boundary is enforced through the relay and through clearly-labeled engine gates inside the codebase. There is no AES-256 runtime artifact, no inert-bytes scheme, no key-management layer on the user's machine — the gate is server-side because that is what is actually unforgeable.

## Core invariants

- Local-first is a product promise, not an implementation detail.
- Robot Dojo servers do not store user private data.
- Raw user data is preserved unless the user explicitly deletes it.
- Derived intelligence must be regenerable from raw data and history.
- The first user is seed data, not a hard-coded product assumption.
- Customer mode is the release default. Owner/dev mode can expose internal fixtures and tooling, but customer mode cannot.
- Background work must be load-aware and must not make the user's machine feel slow.
- No agent should write directly to the database through ad hoc scripts during normal product operation.
- Server-side write paths should use a single-writer event protocol.
- Canonical docs guide future work; generated inventory docs summarize the codebase.
- Human-readable docs distill signal over time instead of accumulating every historical explanation.

## Session Coordination

When multiple Claude Code terminals run against the same repo, they share state through one self-trimming registry (st_8745309c).

- **Registry location:** `PIPELINE_ROOT/sessions.json` (resolved via `lib/robotdojo-paths.js`; gitignored under `user/workbenches/`).
- **Lifecycle:** an entry is created on the first prompt of a session, updated on each heartbeat, pruned from disk when written by another session, and removed on a clean stop event.
- **60-second staleness window:** an entry whose PID no longer responds OR whose last heartbeat is older than 60 seconds is pruned on the next write.
- **Read/write surface:** `lib/session-registry.js` exposes `upsertSession`, `removeSession`, `activeSessions`, and `readRegistry`. The hook at `~/.claude/hooks/robotdojo-session-log.mjs` calls upsert on every prompt and remove on stop.
- **Pipeline integration:** `/story` creates or updates the active session record; `/scope` reads the same registry before sealing so concurrent terminals see the same work-in-progress truth.

Worktree sessions never write the production database. `lib/db.js` hard-refuses to open the production DB when `ROBOTDOJO_WORKTREE=1` (or `.git` is a file, indicating a worktree) and no `ROBOTDOJO_DATABASES_ROOT` override is set. `scripts/worktree-init.sh` configures the override automatically.

## Planning time

Kanban Day 0 means the current calendar day for the current session. Plans should be expressed as N days from today, then calibrated against recent actual velocity.

Launch plans should answer practical questions like "how many days until this is shippable?" without requiring the reader to remember an old anchor date.
