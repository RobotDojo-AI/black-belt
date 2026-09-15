# Build Conventions
<!-- HUMAN-AUTHORED. REGEN BLOCKED. -->

Portable build rules. Loaded globally in all projects.

The Staircase Solve Virtue is the load-bearing discipline behind every convention below: refuse the lazy fix, refuse the wandering exploration, spend exactly the tokens it takes to ship the permanent solution. The default-quality contract (agents/default-quality.md) is the structural form: 10/10 by default, waiver only on the user's verbatim approval of the named gap. The conventions are downstream; the virtue is what each convention is protecting.

## Build Personas

Six agents, isolated context windows. Miyagi orchestrates + talks to owner.

- Miyagi (宮城) — orchestrator + thinking partner. Always running.
- Tantei (探偵) — codebase mapper. Spawn when story touches code needing a map.
- Hakase (博士) — external researcher. Spawn when story needs knowledge outside the codebase.
- Ori (織) — schema + design architect. Spawn when story is multi-phase or needs schema/API design.
- Katagami (型紙) — builder. Spawn after plan is sealed.
- Bunshin (分身) — mandatory stage QC auditor (user's split-self). Runs before presenting research, scope, plan, build, and QA artifacts; close uses Bunshin only when it introduces new judgment, waiver, failed-QA handling, rollback guidance, or product/architecture claims. Bunshin never owns process state.

## Pipeline conventions

/goal is the top-level router. It chooses one of the three tracked intake skills: /story, /defect, /work. Story/defect then move through fixed stages: /framing → /research → /scope → /plan → /build → /qa → /close. Every stage writes one artifact, seals it, and stops for explicit owner approval. Files live at `agents/skills/{name}/SKILL.md`. VC sections in 02-plan.md are headed `## How ACs are satisfied`.

- Framing starts from the user's lived outcome, not the system layer. Every story, including backend/process/deployment work, must name the user value it protects before naming the machinery. Technical detail belongs in research, scope, and plan.
- "Pick up {id}" / "resume {id}" → read `user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/{id}/meta.json` `stage`, route to matching next skill. Never infer "build" from "pick up."
- Pasted build briefs are context, not a bypass. Advance through missing stages first.
- Custom invocation forms that duplicate /goal, /story, /defect, /work, or a stage skill get rejected — confirm the existing pattern doesn't cover the goal before scoping new syntax.
- No unapproved artifacts outside `user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/{id}/`. Two output classes: pipeline artifacts (per STORY_SCHEMA.json) + product files (lib/, routes/, apps/, scripts/). Everything else is rot.
- NEVER spawn Agent() ad-hoc. All spawns through stage skills (/research → Tantei + Hakase; /plan → Ori when needed; /build → Katagami).
- Don't call EnterPlanMode for /plan — native plan mode conflicts with canonical 02-plan.md path. Write directly.
- Research file always `01-research.md`. Archive: `~/.robotdojo/research/{date}-{story_id}-{slug}.md`. Filenames in `STORY_SCHEMA.json`.

## Thin Facade Pattern

Routes are HTTP plumbing — parse, delegate, respond. Domain logic in `lib/` as named `(db, ...params)` functions.

- Zero `db.prepare` in route files. Extract to lib/.
- Deps injected as arguments — no globals, no module-level singletons as implicit deps.
- One responsibility per function. If not nameable in 3 words, it's too much.
- Inline blocks >~10 LOC in a route → extract.
- Extraction at story time, not as cleanup debt.

Gate: `scripts/check-thin-facade.js <route-file-or-dir>` (excludes comments). Does NOT recurse — run per subdirectory: `check-thin-facade.js routes/ && check-thin-facade.js routes/setup/`. Both required in done criteria.

## Clean up test artifacts by definition

Any scratch file, throwaway script, test conversation, or temp/seed data a build or QA pass creates is deleted before the stage seals — by definition, not on request. The user should never see your test residue and should never have to ask you to remove it. Verification uses the real app paths and real data; if a check needs a throwaway artifact, delete it the moment the check is done. This is part of the done criteria, not optional cleanup debt.

## Entity Extraction Hierarchy

Priority → source → truth type → access:
1. Contacts — stated / deliberate curation — Mac SQLite
2. Photos — revealed + actual — Mac SQLite + Google Photos
3. Calendar — planned + stated, noisy — Google Calendar + Mac SQLite
4. SMS/iMessage — revealed + actual — Mac SQLite
5. Notes — stated / deliberate — Mac SQLite
6. Transcripts — actual / meeting body — Granola/Whisper
7. Email — stated + cheap, most noise — Gmail API

RAG runs AFTER entity extraction, not in parallel. In the entity pipeline, email addresses and phone numbers are seeds for entities: create new people or link known ones (role-account blocklist applies; newsletters never seed). In the transcript product, entities come from calendar invites and tie back to the entity graph — transcript attendees link via invite email addresses, never create from transcript text. Company creation from email follows COMPANY_CREATION_SOURCES in scripts/ingest/02-resolve.js.

## Directory Structure

Every top-level directory has a single defined purpose — see `architecture/ontology.md`. Enforced pre-commit by `scripts/gate.js`. Consult `architecture/ontology.md` before creating any new file or dir.

System map at `architecture/sitemap.md` (root, deterministic, generated by `scripts/generate-sitemap.js`, hard cap). `architecture/architecture.md` (root) = non-technical overview.

## Non-blocking child process in ESM

```js
import { spawn } from 'node:child_process';
spawn(process.execPath, ['/abs/path/to/script.js', '--arg', v], { detached: true, stdio: 'ignore' }).unref();
```

Rules: (1) `node:child_process` named import; (2) `process.execPath` for binary; (3) `detached:true` + `stdio:'ignore'` + `.unref()` all three required; (4) absolute paths — ESM doesn't resolve relative reliably in children.

## Security Model

- Bearer auth: `timingSafeEqual` on all API key checks. No early-exit string compare.
- PUBLIC_ROUTES: any new route handling its own auth (subscription Bearer, webhook HMAC) added to `PUBLIC_ROUTES` in `lib/server.js`. Global `/api/*` middleware returns 403 for unrecognized Bearer.
- IP trust: `x-vercel-forwarded-for` on Vercel; elsewhere opt-in via `TRUSTED_PROXY=true`. Never trust `x-forwarded-for` by default.
- safeRedirect rejects CRLF + off-host before `Location:`.
- DB encryption required unless path under `~/robotdojo/user/databases/`, `~/.robotdojo/`, or `ROBOTDOJO_ALLOW_PLAINTEXT=1`.
- CORS allowlist: primary domains + subdomains + localhost only. No wildcard.
- Rate limits: `/api/chat/stream` auth-gated, 100/hr/IP. `/api/public-chat` body ≤1MB.
- New `process.env.X` in `lib/`, `routes/` or `index.js` must add check/warn block to `install.sh` before commit.
- Every `await c.req.json()` wrapped in try/catch returning `{error:'invalid_json'}` status 400.
- No personal names in docs/examples — use `person-a`, `client-a`, `project-name`. PII scanner blocks real names anywhere staged.

Local server TLS: done criteria use `https://localhost:4338 -sk`. HTTP on 4339 = tunnel-agent internal only. Playwright `baseURL` same rule. Node `fetch()` probes: `NODE_TLS_REJECT_UNAUTHORIZED=0`.

API key retrieval (done criteria + tests): `API_KEY=$(security find-generic-password -s "robotdojo-ROBOTDOJO_AUTH_TOKEN" -w)`. Never `~/.robotdojo/api-key`.

New API-key integration = one descriptor in `lib/integration-registry.js`. The reconciler derives its accounts row, page-catalog row, and session visibility at boot + the 15-minute cadence; keychain-stored tokens without a descriptor are auto-discovered. The consumed `seed-api-key-integrations` migration is history — adding rows there does nothing.

Live DB path: `~/.robotdojo/robotdojo.db` is the live database — `lib/db.js` default (`config.configDir`), ~6.3GB, the path the running server holds open (verified via `lsof`, active WAL). Stale leftover: `~/robotdojo/user/databases/robotdojo.db` (~240MB, frozen 2026-06-01). Any criterion referencing the stale `user/databases` path silently passes — pin `~/.robotdojo/robotdojo.db`.

GitHub repo deletion needs `delete_repo` scope: `gh auth status`; if absent `gh auth refresh -h github.com -s delete_repo`. Without it, `gh repo delete` returns HTTP 403 silently.

## Compute Tier Protocol

Tier ladder, never skip. Skipping Tier 1 → Sonnet on bulk = 100x cost failure.

- Tier 0: local (regex, SQL, embeddings cosine). Free. Always first — filter, dedupe, bucket, score structurally.
- Tier 1: Haiku, ~$0.001/1K. After Tier 0 narrows. Large-batch classification, noise removal.
- Tier 2: Sonnet, ~$0.015/1K. Where Haiku flagged high-value. Synthesis on pre-filtered.
- Tier 3: Opus, ~$0.075/1K. Critical decisions, final synthesis where nuance matters. Never in pipelines.

Pattern: Tier 0 removes structural noise → Tier 1 scores relevance → Tier 2 processes high-value subset → Tier 3 only for critical finals.

Any new bulk-data pipeline shows tier selection in top-of-file comment.

## Intelligence Tier Protocol

Every `.js` in `scripts/` that calls `getAnthropicClient()` or references `MODELS.` must declare `export const INTELLIGENCE_TIER = '{tier}'`. Three tiers:

- `extraction` — deterministic; no LLM; writes to DB/structured store.
- `synthesis` — reads structure, calls LLM, writes to canonical markdown only.
- `orchestration` — coordinates the others; no direct LLM calls to structured data.

LLM write boundary (inviolable): LLMs read graph/DB; write only to canonical docs. No LLM may write a DB row/edge. Deterministic code reads LLM markdown and decides structured updates. Enforced by `check-structure.js` pre-commit. Missing INTELLIGENCE_TIER = STOP-THE-LINE.

## Key Design Principles

1. Timeline internal, never user-facing. Users see synthesized intelligence, not raw evidence.
2. Weight revealed over stated, actual over planned. Photo together > calendar invite. SMS thread > CC'd email.
3. Entity resolution deterministic. 5-guard matcher. Never trust LLM for identity.
4. Graceful degradation. Never fail on missing data — log + process what's available.
5. Content-hashed event IDs: `event_id = SHA256(source + source_id + content)` for dedup.
6. Family/relationships inferred from contact labels + calendar patterns + name clustering, never configured.
7. Nightly lint: contradictions, stale claims, orphans.
8. Entity matching binary: ≥0.85 link, below create. No review zone.
9. Compute tier ladder: Free → Haiku → Sonnet → Opus, in order.

## Tier Enforcement

- White Belt: MIT, fully open source. Anyone can audit, fork, and run it on their own hardware.
- Black Belt: source-available under the Elastic License v2 (ELv2). Code is public for audit; active subscription required. The relay is the hard server-side gate — subscription state lives server-side, not client-side.
- User's raw data is never encrypted by us — always theirs.
- On subscription lapse: engines pause, relay ends, data preserved read-only. Raw files, databases, history, topics, workbench outputs, user files, account settings, entity markdowns stay on device. Reactivation restores active use.

## Merkle Memory Log

Append-only content-addressed log with Merkle verification. Portable across machines/tiers. Canonical home: `user/memory/` (per-machine; gitignored). Spec: `docs/memory-log-spec.md`.

## External Replication

Litestream incompatible with `better-sqlite3-multiple-ciphers` — cipher encrypts WAL header → `SQLITE_NOTADB (26)`. Fallback: `gcloud storage rsync` periodic via LaunchAgent (~15 min RPO).

## Migration discipline

Before declaring complete: `ROBOTDOJO_ALLOW_PLAINTEXT=1 node scripts/check-migration-completeness.js`. Exit 0 = good, 1 = gaps listed. A migration isn't complete until all structured, curated, and config data are present.

- SQL file ordering: `lib/migrations/*.sql` runs inside `applySqlMigrations()` BEFORE inline `migrate()` calls. New SQL touching tables created by inline migrate must `CREATE TABLE IF NOT EXISTS {table}`.
- File numbering: check `ls lib/migrations/*.sql | sort | tail -1` before naming. Assumed numbers without checking conflict with prior consumed numbers.
- WAL checkpoint before batch writes: `db.transaction()` that may re-run after interrupted session must `db.pragma('wal_checkpoint(RESTART)')` first. Killed-process reader marks cause `SQLITE_BUSY_SNAPSHOT` hang.
- `INSERT OR IGNORE` with deterministic `source_id` after extraction-query fix: prior false-positive rows survive. DELETE affected rows before re-running: `DELETE FROM {table} WHERE {condition} AND source_id LIKE '{prefix}%'`.
- SQLite NOT NULL: cannot drop via ALTER TABLE without full rebuild. Before planning to null a column: `PRAGMA table_info(TABLE)` to verify. Workaround: dual-write old+new until old can be dropped.

## Chat Speed

The product. P0 regressions.

- Context-routing deterministic — never LLM on critical path. Topic from UI; route via registry lookup.
- No topic = no RAG. Query without topic returns general system prompt only. RAG opt-in, not default.
- All fetches parallel via `Promise.allSettled`. No waterfalls.
- API warmup every 2 min while active. Sonnet + Haiku sockets stay warm via LaunchAgent. Boot warmup primes Gemini + sqlite-vec + Anthropic.
- Speculative prefetch on user typing pause. `/api/prefetch` fires during dead time so RAG is done by submit.
- Speculative sonnet ping at request entry — pay TLS+auth RTT in parallel with context build.
- TTFT measured on `chat_turn_metrics.first_token_ms` (first model delta, not first SSE event).
- Target: warm TTFT ≤2500ms, cold ≤4000ms with Sonnet 4.6.

## Git Discipline

- Session-bus read-before-branch: the session registry (`lib/session-registry.js`) and active-builds claims are WRITTEN automatically — agents must also READ them. Before any branch-mutating git op (`checkout`, `switch`, `checkout -b`) on a shared checkout, consult `activeSessions()`; with another live session on the same tree, use a worktree or stop. Before `git commit`, assert HEAD still equals the active story branch (`story/<id>-…`) — a parallel session can switch HEAD between staging and commit.
- Unanchored `.gitignore` directory patterns match at any depth. `quarantine/` matches both `~/robotdojo/quarantine/` AND nested `~/robotdojo/lib/quarantine/`. Anchor top-level with leading `/`. Verify: `git check-ignore -v <path>`.
- `.gitignore` is policy, never a workaround. Misplaced files get moved/fixed, not silenced. `scripts/check-gitignore.js` rejects gitignore lines masking structural violations.
- Newly-gitignored already-tracked files: `git rm --cached --ignore-unmatch <path>`.
- Pre-destructive-op stash gate (CRITICAL): before `git filter-repo`, `git reset --hard`, cross-history checkout, `git clean -fd`, OR per-file `git checkout <path>` when ANY working-tree changes exist — MUST `git stash push --include-untracked -m "pre-X-stash-$(date +%s)"` first. After op: `git stash pop` + resolve. Single-file checkout destroys WIP as completely as `git reset --hard`. Without stash, concurrent-session WIP is destroyed silently.
- `git filter-repo` content scrub = 4 passes: (1) `--invert-paths --path-glob` for whole files, (2) `--replace-text` literal for surviving content, (3) `--replace-text regex:(?i)` case-insensitive, (4) `--replace-message` for commit messages. Verify between: `git log --all -p | grep -ciE '<pattern>'` should hit 0.
- `git filter-repo --replace-text` over-scrubs `scripts/gate-pii.sh` (scanner's literal patterns get redacted, breaking detection). Carve out via `--paths-from-file` or restore patterns post-rewrite.
- `git filter-repo` strips `origin` remote. After: `git remote add origin <url> && git fetch origin` before any `git push --force-with-lease`.
- Worktree + live DB trap: db.js resolves DB as `process.env.ROBOTDOJO_DB || resolve(config.configDir, 'robotdojo.db')` (i.e. `~/.robotdojo/robotdojo.db`) — absolute, ignores `__dirname`. Worktrees share main DB. Backfills writing to gitignored dirs (`transcripts/`, `databases/`) update main DB with WORKTREE paths. Post-merge fix: reset all `file_path` columns to NULL and re-run in main repo context.

## Criteria-Runner Discipline

- Requires `~/robotdojo` CWD. Done criteria use `node --input-type=module -e "import db from '$HOME/robotdojo/lib/db.js'..."` — CWD-relative resolution. Pattern: `cd ~/robotdojo && node ~/robotdojo/scripts/criteria-runner.js ...`.
- Keychain creds passed explicitly: `ASANA_PAT="$(security find-generic-password -s "robotdojo-ASANA_PAT" -w)" node scripts/criteria-runner.js ...`. Subprocess can't read Keychain.
- Absence-of-pattern criteria must exclude comments. Recursive `grep -rn` output is `filename:N:content` — filter is `':[0-9]*:[[:space:]]*//'` (leading `:`), NOT `'^[0-9]*:'`. Probe actual grep output before writing the filter.
- Path migration audit: any story migrating filesystem paths must scan `~/robotdojo/agents/skills/`, `~/robotdojo/scripts/`, `~/robotdojo/lib/`, and `~/robotdojo/routes/` in done criteria. A single stale ref in any script silently recreates the old file on next invocation.
- User-data files moving into repo tree: (1) `git check-ignore -v <file>` — if not gitignored AND contains personal data, gitignore before commit; (2) `scripts/gate-pii.sh --files <file>` to verify pre-commit won't block.
- Health endpoint format: `/health` = HTML dashboard, no "ok" string. `/api/server-health` = `{"status":"ok",...}`. Never grep `/health` for "ok".
- LaunchAgent plist env change: verify running env, not just plist. Pattern: `launchctl print system/com.robotdojo.server | grep ROBOTDOJO_DB | wc -l | tr -d ' ' | grep -q '^0$' && echo ok`.

## Canonical Doc Architecture

All canonical surfaces are hand-curated. No autonomous doc writer. Surfaces in `architecture/surfaces.json` carry `class:human-authored`, `owner_script:null`, `trigger_config.events:[]`. Schema and policy gates reject autonomous writer fields and trigger events.

Pre-commit gates fire on every commit:
- `check-registry-schema.js` — registry shape valid; required fields present.
- `check-canonical-mode.js` — rejects entries re-introducing autonomous-write pattern.
- `check-doc-budget.js` — every surface within `max_chars`.
- `gate-human-authored.js` — staged human-authored edits require active story declaring file in `meta.json.touches`.

Owner edits via Edit + commit; no autonomous path writes a canonical surface.

## Quarantine Stop-The-Line

`scripts/smart-quarantine.js --execute` auto-moves misplaced files to `quarantine/`. Files >24h there = `qgrace` STOP-THE-LINE, blocks all commits. Before any commit: `node scripts/check-structure.js 2>&1 | grep qgrace`. Resolve before staging. The `quarantine/` directory is created on auto-move events; absence on disk is normal and means the tree is clean.

## Public Website Deploy Protocol

Every owned public website follows the same three-step sequence on every deploy:

1. **Build** generates: `sitemap.xml` (per-URL lastmod), `robots.txt` (AI bot opt-ins), `llms.txt` (llmstxt.org-compliant with content), `llms-full.txt` (full corpus), JSON-LD schema.org on every page.
2. **Push** commits and pushes to main — Vercel deploys automatically.
3. **IndexNow ping** via `scripts/submit-indexnow.js` — POSTs updated URLs to api.indexnow.org (covers Bing, Yandex, Naver, Seznam, Yep). Fires immediately after push, not inside Vercel build.

Enforcement: the site's canonical deploy entrypoint must include all three steps. For robotdojo.ai: `scripts/deploy-vercel.sh`. Adding a new public site means creating a deploy script that runs build → push → IndexNow and registering it as a skill.

Google is handled by sitemap + lastmod only — Google does not participate in IndexNow, and its Indexing API is restricted to JobPosting/BroadcastEvent content.

## Public Website SEO Standards

Every Robot Dojo public site must meet these standards at every deploy. A new site is not shippable until all four hold.

**1. Sitemap lastmod is git-derived, never a build timestamp.**
- File-backed pages: `git log -1 --format=%cI -- <source-file>` → YYYY-MM-DD.
- Aggregator pages (e.g. a posts feed): newest item date from the content source.
- Fallback to today only for genuinely untracked new files.
- Build-timestamp lastmod (`new Date()` or equivalent used uniformly) is a freshness-signal lie — Google detects and discounts it site-wide.

**2. Content pages render a visible published date and, where updated, a "last updated" date.**
- Derived from git, not hardcoded strings or absent.
- For sites with a Node.js build step: inject from `git log` at build time.
- For static HTML (no build step): pre-commit hook injects the commit date into the file on each edit — the committed value equals the git commit date for that file.

**3. A stale-date gate exits non-zero before deploy.**
- Sites with a build step: a `check-sitemap-freshness.js` script re-derives expected dates from git and diffs against the generated sitemap. Exits 1 on mismatch.
- Sites with a pre-commit generator (e.g. `generate-marketing-sitemap.js --check`): the `--check` flag verifies the committed sitemap matches the current git dates.
- Neither site can deploy silently with stale dates.

**4. Keywords, JSON-LD, and structured metadata are present and gated.**
- Every indexed page carries `<meta name="keywords">`, full og:* + twitter:* tags, and at least one JSON-LD block.
- Content pages carry `datePublished` and `dateModified` in JSON-LD.
- A metadata gate script (`check-marketing-metadata.js` or equivalent) covers every indexed page — including subdirectory pages — and is run in CI or pre-commit.

**When adding a new public site:** satisfy all four standards before first deploy. The `/scaffold-site` skill (to be written on the second new site) will scaffold the infrastructure. Until then, derive the pattern from st_ba0a385d (the reference implementation).
