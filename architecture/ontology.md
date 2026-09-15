# Repository Ontology

_Generated 2026-09-15 by `scripts/generate-ontology.js` (deterministic; no LLM). Source of truth: `config/root-allowlist.lock.json`._

Every top-level directory has a single defined purpose. `scripts/check-root-lock.js` and `scripts/gate.js` enforce this pre-commit. To add a new top-level directory, the owner must approve an exact edit to `config/root-allowlist.lock.json`.

**Quarantine rule:** Any file or directory that lands at root outside the allowlist auto-moves to `quarantine/` and the build breaks. Resolve by routing to correct location — quarantine is a stop-the-line signal, not a parking lot.

## Top-Level Directories

| Directory | Purpose | Belongs | Does NOT belong |
|-----------|---------|---------|-----------------|
| `agents/` | Canonical Robot Dojo Agent OS: roster, personas, build skills, generated adapters | roster.md, personas/*.md, agents/skills/*/SKILL.md, quality/build contracts, generated dist/ | User profile, private memory, runtime data |
| `api/` | Public Vercel serverless functions | Public-facing edge functions | Business logic |
| `apps/` | Frontend applications | Browser HTML, JS, CSS, and assets | Backend logic |
| `architecture/` | Architecture and canonical documentation surfaces | architecture/product.md, architecture/architecture.md, architecture/structure.md, generated architecture/sitemap.md, generated architecture/ontology.md, architecture/surfaces.json | Runtime code, private user data, process artifacts, or generated public bundles |
| `code/` | External repos, gitignored and GCP-backed | Git clones of linked external repos | Committed product source |
| `config/` | Configuration and registries | Models, voices, taxonomy, account settings, lock files, registries | Secrets or raw data |
| `docs/` | Robot Dojo/product/operator documentation | Human-facing product and operator docs | Product truth, planning artifacts, raw user files, derived workbench analysis |
| `gateway/` | Canonical WebSocket/TCP/SNI gateway deployment source | Hono server, Redis integration, Docker config, Terraform deploy source, deploy scripts, device registration, tunnel routes, and blind TCP/SNI relay code | Application business logic |
| `lib/` | Core reusable business logic | Reusable modules, integrations, data pipelines | Route handlers, scripts, frontend code |
| `pipeline/` | Retired (st_0c491456 Phase 3e). The dev pipeline (kanban, stories, generalizations, schema) relocated to user/workbenches/topics/work/robot-dojo/wk_robot_dojo/ (st_9699c94f). This entry remains only so the existing untracked scratch directory does not trip the root allowlist; no tracked files may land under it (check-root-lock enforces). | Untracked scratch only (legacy quarantine-manifest.jsonl, archive/, batch-prep/, research/, reports/, sessions/). Nothing canonical. | Tracked files of any kind; any new dev-pipeline artifacts (those go to the wk_robot_dojo workbench) |
| `quarantine/` | Stop-the-line holding zone for misplaced files | Temporary files awaiting routing | Permanent storage |
| `routes/` | HTTP route handlers | Hono route files | Business logic or frontend code |
| `scripts/` | Operational, QA, migration, and generator scripts | Scripts run by humans, CI, cron, install, QA, and build-pipeline support | Library code or route handlers |
| `tests/` | Automated tests and fixtures | node:test files, fixtures, Playwright specs, shell-fixture tests | Product source |
| `user/` | Private per-user substrate | profile, inbox, imports, files, contexts, workbenches, transcripts, memory, databases, logs, media, models | Tracked source code, product docs, canonical Agent OS definitions |

## Top-Level Files

Files approved at root by Node.js, npm, Vercel, GitHub, install, test, or lock conventions. Nothing else.

| File | Purpose | Required |
|------|---------|----------|
| `.gitignore` | Repo-wide ignore policy | Yes |
| `.vercelignore` | Vercel deploy exclusion policy | Yes |
| `.worktreeinclude` | Files copied into a new git worktree by `claude --worktree` (st_8745309c) — currently .env.local for DB isolation | No |
| `ACCOUNT_RECOVERY.txt` | Local operator account recovery instructions | Yes |
| `AGENTS.md` | Install symlink (or file) to agents/dist/AGENTS.md for Grok/Codex project roots | Yes |
| `CLAUDE.md` | Claude Code project adapter | Yes |
| `LICENSE` | Repository license | Yes |
| `LICENSE-BLACKBELT` | Black Belt source-available license (Elastic License 2.0); White Belt root LICENSE stays MIT | Yes |
| `README.md` | Public repository overview | Yes |
| `identity.example.json` | Example local identity configuration | Yes |
| `index.js` | Server entry point | Yes |
| `install.sh` | Terminal install path | Yes |
| `knip.json` | Dead-code/dependency analysis config | Yes |
| `middleware.js` | Vercel edge middleware | Yes |
| `package-lock.json` | npm lockfile | Yes |
| `package.json` | Node.js project manifest | Yes |
| `playwright.config.js` | Playwright test config | Yes |
| `skills-lock.json` | Installed skill/plugin lockfile | Yes |
| `stryker.config.mjs` | Mutation testing config | Yes |
| `vercel.json` | Vercel deployment configuration | Yes |

## Rules

1. No planning docs at root. Plans live inside the owning story, defect, or workbench.
2. No catch-all directories. A directory named `misc/`, `tmp/`, `stuff/` accumulates entropy. Name directories by what they contain.
3. No loose scripts at root. One-off scripts go in `scripts/`. Subsystem-owned scripts live inside that subsystem.
4. `scripts/` subdirs are action-named: `scripts/ingest/`, `scripts/qa/` — not `scripts/pipeline/` (ambiguous with `pipeline/`).
5. Adding a new top-level directory requires owner approval and an exact edit to `config/root-allowlist.lock.json`.
6. Quarantine is a stop-the-line signal, not a parking lot. A file in `quarantine/` means the architecture is violated.
7. Private user substrate lives under `user/`: `user/files/` for source evidence, `user/contexts/` for compact context packages, and `user/workbenches/` for deep working sets.
