#!/usr/bin/env bash
# pre-commit.sh — git pre-commit hook for the robotdojo repo.
#
# Steps, in order:
#   1.  PII scan — refuses commits with known owner-PII patterns (gate-pii.sh).
#   2.  Structure check — auto-moves violations to quarantine/ then exits 1
#       (stop-the-line) so the dev rebuilds the commit on a clean tree.
#   2a. Smart-quarantine apply — classifies and routes anything in quarantine/
#       to its canonical home, writing pipeline/quarantine-manifest.jsonl.
#       Tier 0 short-circuits cost nothing; Tier 1 (Haiku) is ~$0.001/file.
#   2b. Gitignore audit — refuses commits when a .gitignore line is being used
#       as a workaround for a structural violation (e.g. silencing a misplaced
#       file instead of moving it to its canonical home).
#   3.  FAQ bundle regeneration — if any apps/static/faq/*.json files are
#       staged, regenerate lib/public-chat/faq-bundle.js and stage it.
#
# Install: ln -sf ../../scripts/pre-commit.sh .git/hooks/pre-commit

set -euo pipefail

# Resolve REPO_ROOT from the COMMITTING worktree: git runs the hook with cwd at
# that tree's top level, so `--show-toplevel` is worktree-correct and a commit
# from a linked worktree regenerates, checks and stages ITS OWN files. Deriving
# it from this script's path instead always resolved to main (the symlink
# target), staging the de-tax into main's index. Falls back to a script-path
# walk (through symlinks, up to the dir containing .git/) if git is unavailable.
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$REPO_ROOT" ] || { [ ! -d "$REPO_ROOT/.git" ] && [ ! -f "$REPO_ROOT/.git" ]; }; then
  SCRIPT_PATH="${BASH_SOURCE[0]}"
  while [ -L "$SCRIPT_PATH" ]; do
    SCRIPT_PATH="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)/$(readlink "$SCRIPT_PATH")"
  done
  SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  REPO_ROOT="$SCRIPT_DIR"
  while [ "$REPO_ROOT" != "/" ] && [ ! -d "$REPO_ROOT/.git" ] && [ ! -f "$REPO_ROOT/.git" ]; do
    REPO_ROOT="$(dirname "$REPO_ROOT")"
  done
fi
if [ ! -d "$REPO_ROOT/.git" ] && [ ! -f "$REPO_ROOT/.git" ]; then
  echo "[pre-commit] could not locate repo root" >&2
  exit 1
fi

# ── 0. De-tax (st_862d73d1 AC9): delegate regenerate-and-stage to detax.sh ────
# Thin Facade: pre-commit is an orchestrator. The ONLY regenerate-and-stage
# logic — maps, public-truth/faq corpus, agent dist adapters, plus the
# meta.touches+approval bootstrap for the just-staged deterministic outputs —
# lives in scripts/detax.sh, which we `source` so it shares $REPO_ROOT and the
# resolved DETAX_STORY in this one shell. Every CHECK-only gate stays inline
# below. detax.sh is set -u-safe and is extracted+run standalone by
# detax-public-truth.test.js.
source "$REPO_ROOT/scripts/detax.sh"

# ── 1. PII scan ───────────────────────────────────────────────────────────────
"$REPO_ROOT/scripts/gate-pii.sh"

# ── 1a. Public-config leak scan (st_e36f5f2b) ────────────────────────────────
# The complement to gate-pii.sh: catches the leak class the name/email/secret
# scanners miss — bare owner-org DOMAINS, real 16-digit Asana workspace/project
# gids, and calendar-import ids committed to tracked files. Owner routing lives
# in the gitignored config/*.user.json overrides; the guard cross-checks that
# none of those domains leak into tracked source. No-op on a fresh clone with no
# overrides. Runs right after the PII scan — same class, same stop-the-line.
node "$REPO_ROOT/scripts/check-public-config-clean.js"

# ── 1a2. First-user completeness gate (st_e36f5f2b AC5) ──────────────────────
# The load-bearing "clean" definition: cross-references the owner's derived
# identity+entity corpus (from the gitignored config/*.user.json overrides,
# family.json, and the on-disk entity graph) against the STAGED files — contents
# and paths. Catches the free-text employer/taxonomy/entity classes the name/
# email/gid scanners miss. --staged is incremental (staged files only); the full
# publication certification is `check-first-user-clean.js --all` on the owner's
# box (corpus present). No-op on a fresh clone with no local corpus. The corpus
# cache is rebuilt only via --refresh, never here.
node "$REPO_ROOT/scripts/check-first-user-clean.js" --staged

# ── 1b. Registry schema gate (st_ae536261) ──────────────────────────────────
# Validates architecture/surfaces.json against config/registry-schema.json.
# Every entry must declare max_chars. Runs before check-doc-budget so a schema
# violation surfaces before the measured-size check (a registry entry without
# max_chars is a structural failure; you cannot enforce a budget you didn't
# declare). Autonomous writer fields are rejected by schema/policy gates.
node "$REPO_ROOT/scripts/check-registry-schema.js"

# ── 1b2. Canonical-mode gate (st_5285c160) ──────────────────────────────────
# Enforces the single hand-curated mode established by st_5285c160. Rejects
# entries that re-introduce the dead autonomous-write pattern:
#   - owner_script referencing a non-existent script
#   - trigger_config.events non-empty
#   - class is anything except the current hand-curated/manual/log modes
# Structural (schema) → policy (mode) → size (budget). This is the policy gate.
node "$REPO_ROOT/scripts/check-canonical-mode.js"

# ── 1b3. Root allowlist lock gate (st_608fe3ed) ─────────────────────────────
# The repo root allowlist is architecture. It lives in
# config/root-allowlist.lock.json and cannot be expanded by generators or build
# scripts. Any protected architecture file staged in a commit must be named
# exactly in story meta.touches and approved in the local non-repo approval file.
node "$REPO_ROOT/scripts/check-root-lock.js"

# ── 1b4. Spend gates (st_4312c9c0) ──
node "$REPO_ROOT/scripts/check-tier-raise.js" || { echo "pre-commit: tier raise"; exit 1; }
node "$REPO_ROOT/scripts/check-tier-policy-match.js" || { echo "pre-commit: over tier"; exit 1; }
node "$REPO_ROOT/scripts/check-no-tokens-free.js" || { echo "pre-commit: retired ethos"; exit 1; }
node "$REPO_ROOT/scripts/check-raw-llm-clients.js" || { echo "pre-commit: raw llm"; exit 1; }
node "$REPO_ROOT/scripts/spend-surface.js" >/dev/null || { echo "undeclared trigger"; exit 1; }

# ── 1c. Doc-budget gate (st_a78848a0 + st_ae536261) ──────────────────────────
# Hard-mandatory budget enforcement. NO escape hatch. Reads max_chars from
# canonical-surfaces.json, stats each registered file, exits non-zero on any
# overrun. The fix path is to distill the doc in a story-reviewed edit, OR
# raise max_chars in the registry with owner countersign.
node "$REPO_ROOT/scripts/check-doc-budget.js"

# ── 1c2. Doc-budget RAISE sign-off gate (st_862d73d1 AC4) ────────────────────
# A budget going UP is telemetry that a file is taking on too much, not routine.
# Blocks any architecture/surfaces.json max_chars increase (staged vs HEAD)
# lacking an owner-countersigned approval in ~/.robotdojo/doc-budget-approvals.json.
# Decreases and new surfaces pass. Mirrors the root-lock approval pattern; the
# agent cannot fabricate the owner's verbatim quote. Mirrored in CI (root-lock.yml).
node "$REPO_ROOT/scripts/check-doc-budget-raise.js"

# ── 1e. Canonical readers gate (st_ae536261 Phase 7) ─────────────────────────
# Every agents/skills/*/SKILL.md and every agents/personas/*.md must declare
# canonical_reads: [architecture/sitemap.md, architecture/ontology.md] in YAML frontmatter AND have a
# Step 0 / persona-spawn instruction that explicitly invokes those reads.
node "$REPO_ROOT/scripts/check-canonical-readers.js"

# ── 1e1a. Persona ontology gate (st_0c491456 Phase 2a) ──────────────────────
# Validates every agents/personas/*.md against the canonical schema: required
# frontmatter, exactly 7 body sections in fixed order, marker-hash currency,
# exactly the six sanctioned personas. Wired here so it fires immediately
# after the canonical-readers structural check.
# AC-10 (st_1cfe9061): scoped to this session's staged .md files so two
# parallel terminals don't block each other on unrelated persona changes.
STAGED_MD_FILES=$(git diff --cached --name-only --diff-filter=ACMR | { grep '\.md$' || true; } | while read -r f; do echo "$REPO_ROOT/$f"; done | tr '\n' ' ')
if [ -n "$STAGED_MD_FILES" ]; then
  # shellcheck disable=SC2086
  node "$REPO_ROOT/scripts/check-persona-ontology.js" --files $STAGED_MD_FILES
else
  node "$REPO_ROOT/scripts/check-persona-ontology.js" --files
fi

# ── 1e1b. Skill ontology gate (st_0c491456 Phase 2b) ────────────────────────
# Validates every agents/skills/*/SKILL.md against the skill schema:
# name/description/type/canonical_reads frontmatter, Contract+Steps sections,
# marker-hash currency, and type-specific requirements.
# AC-10: scoped to this session's staged .md files.
if [ -n "$STAGED_MD_FILES" ]; then
  # shellcheck disable=SC2086
  node "$REPO_ROOT/scripts/check-skill-ontology.js" --files $STAGED_MD_FILES
else
  node "$REPO_ROOT/scripts/check-skill-ontology.js" --files
fi

# ── 1e1c. Architecture doc schema gate (st_0c491456 Phase 2c) ───────────────
# Validates that architecture/{product,architecture,structure}.md carry the
# required `##` sections so the doc class stays predictable.
node "$REPO_ROOT/scripts/check-arch-doc-schema.js"

# ── 1e1d. Fragment ontology gate (st_0c491456 Phase 2d) ─────────────────────
# Validates config/voices/ sub-classification and the fragment include-contract
# (wrappers + sha256 marker + purpose header). Blocks owner-voice files from
# resurfacing at config/voices/.
# AC-10: scoped to this session's staged .md files.
if [ -n "$STAGED_MD_FILES" ]; then
  # shellcheck disable=SC2086
  node "$REPO_ROOT/scripts/check-fragment-ontology.js" --files $STAGED_MD_FILES
else
  node "$REPO_ROOT/scripts/check-fragment-ontology.js" --files
fi

# (De-tax regenerate-and-stage for sitemap/ontology/dist + the resync/notify
#  block moved to scripts/detax.sh, sourced at block 0 above — st_862d73d1 AC9.)

# ── 1e2. Agent OS unified install gate (st_0c491456 Phase 3a) ────────────────
# Single verifier (replaces check-identity-dist-fresh.js + check-skill-adapters.js).
# Asserts: every adapter is a live symlink to canonical (skills, Claude agents,
# Codex, Cursor); no orphan/stray entries; agents/dist/* carry DO-NOT-EDIT
# headers; source→dist fresh (generate-identity.js --check). Fix: bash
# scripts/install-skills.sh.
node "$REPO_ROOT/scripts/check-agent-os.js" || { echo "pre-commit: agent OS install gate failed — run bash scripts/install-skills.sh"; exit 1; }

# ── 1c. Human-authored class gate (st_a78848a0) ──────────────────────────────
# Rejects commits that stage a human-authored canonical surface (per
# architecture/surfaces.json or the HUMAN-AUTHORED marker) unless a
# non-closed story in user/workbenches/topics/work/robot-dojo/wk_robot_dojo/stories/ declares the file in meta.json.touches.
node "$REPO_ROOT/scripts/gate-human-authored.js"

# ── 1f. Print-to-owner voice gate (st_7fcebb44 AC 3b) ────────────────────────
# Scans every print-to-owner block in repo skills and canonical persona files
# for banned voice patterns: padding words, agent-meta
# prose ("Say yes or run /..."), verdict-filler lines, basic passive voice.
# AC-10: scoped to this session's staged .md files when available, so two
# parallel terminals don't block each other on unrelated voice changes.
# Falls back to full scan when no .md files are staged (rare but safe).
echo "[check-print-voice] running..."
if [ -n "$STAGED_MD_FILES" ]; then
  # shellcheck disable=SC2086
  if ! node "$REPO_ROOT/scripts/check-print-voice.js" --files $STAGED_MD_FILES 2>&1; then
    echo "[check-print-voice] FAIL — banned voice patterns detected in print-to-owner blocks. Fix or use <!-- voice-allow: -->." >&2
    exit 1
  fi
else
  if ! node "$REPO_ROOT/scripts/check-print-voice.js" "$REPO_ROOT/agents/skills/" "$REPO_ROOT/agents/personas/" 2>&1; then
    echo "[check-print-voice] FAIL — banned voice patterns detected in print-to-owner blocks. Fix or use <!-- voice-allow: -->." >&2
    exit 1
  fi
fi

# ── 2. Structure check ────────────────────────────────────────────────────────
# Reports violations and exits 1 (stop-the-line). No auto-move — gate.js is
# report-only. Smart-quarantine (2a) handles routing after gate passes.
# To add a new top-level entry: update STRUCTURE.md + scripts/gate.js first.
node "$REPO_ROOT/scripts/gate.js"

# ── 2.1 Generated map freshness ──────────────────────────────────────────────
# architecture/sitemap.md and architecture/ontology.md are source-orientation contracts for every
# specialist brief. Check mode compares generated output to committed docs
# with the generated-date line normalized so daily date drift is not a
# semantic failure.
# st_4312c9c0 AC 19 — both re-derive the whole file inventory (~7.2s/commit);
# sitemap-gate-needed.js exits 0 to run them, 1 when staged files are edit-only.
if node "$REPO_ROOT/scripts/sitemap-gate-needed.js"; then
  node "$REPO_ROOT/scripts/generate-sitemap.js" --check || { echo "pre-commit: sitemap freshness gate failed"; exit 1; }
  node "$REPO_ROOT/scripts/generate-ontology.js" --check || { echo "pre-commit: ontology freshness gate failed"; exit 1; }
fi

# ── 2a. Smart-quarantine manual-only ─────────────────────────────────────────
# Smart quarantine may propose repairs, but pre-commit must not move files or
# mutate manifests behind the owner's back. Run this manually when needed:
#   node scripts/smart-quarantine.js --execute

# ── 2b. Gitignore audit ───────────────────────────────────────────────────────
# Hard-fails the commit if a .gitignore line is masking a structural violation
# instead of fixing it (registry-aware — see scripts/check-gitignore.js).
node "$REPO_ROOT/scripts/check-gitignore.js"

# ── 2c. Literal gate ─────────────────────────────────────────────────────────
# AC-10: scoped to this session's staged .js files so two parallel terminals
# don't block each other on unrelated literal changes. Falls back to full
# directory scan when no .js files are staged (safe no-op in that case).
# Run from REPO_ROOT so relative paths (lib/, routes/, scripts/, index.js)
# resolve to the canonical main-tree locations matched by the ALLOWLISTED set
# inside check-literals.js.
STAGED_JS_FILES=$(git diff --cached --name-only --diff-filter=ACMR | { grep '\.js$' || true; } | while read -r f; do echo "$REPO_ROOT/$f"; done | tr '\n' ' ')
if [ -n "$STAGED_JS_FILES" ]; then
  # shellcheck disable=SC2086
  (cd "$REPO_ROOT" && node "$REPO_ROOT/scripts/check-literals.js" --files $STAGED_JS_FILES)
else
  (cd "$REPO_ROOT" && node "$REPO_ROOT/scripts/check-literals.js" --files)
fi

# ── 2c-sla. SLA coverage + stale-literal gate (st_24c158ae) ──────────────────
# (a) check-sla-coverage.js: enforces that every chat-turn-issuing test file
#     (discovered via the frozen regex documented in scope) calls
#     assertTTFT(elapsed, kind) at least once. Disaster check: assertTTFT must
#     throw on bound exceedance — proves the helper has teeth.
# (b) stale-literal grep: refuses commits that introduce a hardcoded TTFT
#     literal in any test file. The pattern intentionally matches the common
#     bare numbers (3000/4000/2500/3500) when they appear near
#     ttft/ttfb/first.token/warm chat/cold chat. Allowed when paired with an
#     import from config/sla.js (the canonical bound).
(cd "$REPO_ROOT" && node "$REPO_ROOT/scripts/qa/check-sla-coverage.js")
SLA_STALE_HITS=$(grep -rnE "(ttft|ttfb|first.token|warm.*chat|cold.*chat).*[^_]([34]_?[05]?00)\b" \
  "$REPO_ROOT/scripts/qa/tests" "$REPO_ROOT/tests" 2>/dev/null \
  | grep -v "from.*config/sla\|require.*config/sla\|import.*sla" \
  | grep -v "sla-coverage:ignore-file" \
  || true)
if [ -n "$SLA_STALE_HITS" ]; then
  echo "[pre-commit] stale TTFT literal detected — values must flow from config/sla.js:" >&2
  echo "$SLA_STALE_HITS" >&2
  exit 1
fi

# ── 2d. Marketing metadata drift gate (st_e5665b1e amendment) ────────────────
# Refuses commits that introduce a top-level marketing HTML missing any of:
# title, meta description, robots, canonical, full OG set, Twitter Card set,
# or at least one JSON-LD block. Exempts pages with `<meta name="robots"
# content="noindex...">` (app shells). Runs after literal gate so a
# malformed literal is surfaced first.
node "$REPO_ROOT/scripts/check-marketing-metadata.js"

# ── 2d2. Stage artifact timestamp hygiene (df_b78fdb4c) ─────────────────────
# Stage chronology is generated by story-gate seal metadata and criteria
# evidence. Live story/work skills must not ask agents to hand-write prose
# timestamps like `Date: {date}` into artifacts.
node "$REPO_ROOT/scripts/check-stage-artifact-timestamps.js" || { echo "pre-commit: stage artifact timestamp gate failed"; exit 1; }

# ── 2e/2f. Marketing generated files ─────────────────────────────────────────
# Pre-commit is check-first. It does not regenerate or stage marketing output.
# Run these explicitly when changing marketing sources:
#   node scripts/generate-marketing-sitemap.js
# (llms.txt + llms-full.txt are produced by generate-public-truth.js, run in the
#  de-tax above; the old generate-llms-txt.js orphan was deleted in st_fdd414de.)

# ── 2g. Sitewide marketing-file invariants (st_e5665b1e amendment) ───────────
# Checks the four supporting static files (og-image.png, robots.txt, llms.txt,
# llms-full.txt) and the regenerated sitemap.xml conform to required shape.
# Catches: missing og-image, robots.txt drift (AI bot blocks removed), llms.txt
# truncated, llms-full.txt body extraction broken, sitemap missing lastmod.
node "$REPO_ROOT/scripts/check-marketing-files.js"

# ── 2j. Idle-gate registry gate (st_f6315f0b) ────────────────────────────────
# Rejects commits that add or modify a com.robotdojo.*.plist whose entrypoint
# script does not declare `IDLE_GATED = true|false`. The contract: every
# launchd worker classifies itself as gated-on-user-idle or not, with a
# rationale comment when false. The watchdog and the qa runners depend on
# this invariant being true at HEAD.
node "$REPO_ROOT/scripts/check-idle-gated.js" || { echo "pre-commit: idle-gated declaration gate failed"; exit 1; }

# ── 2k. Installer-parity gate (st_bc949e7c) ──────────────────────────────────
# Enforces parity between config/launch-agents.json, apps/static/launch-agents/
# *.plist.template, and apps/static/install.sh. Three checks:
#   (a) every manifest entry has a matching template file
#   (b) every template file has a manifest entry (no orphans)
#   (c) install.sh has no literal `launchctl load com.robotdojo.*` for a label
#       not in the manifest (variable-driven loads are skipped — they're
#       manifest-walking by construction)
node "$REPO_ROOT/scripts/check-installer-parity.js" || { echo "pre-commit: installer parity gate failed"; exit 1; }

# ── 2k2. Runtime writer safety gate (st_76aec6ef) ───────────────────────────
# Enforces the launch DB writer contract across runtime, commit, and install
# paths: LaunchAgents, direct DB writer manifest, and installer parity must all
# agree before code can land.
node "$REPO_ROOT/scripts/check-runtime-writer-safety.js" || { echo "pre-commit: runtime writer safety gate failed"; exit 1; }

# ── 2k3. Background routine registry gate (st_9adac780) ────────────────────
# Enforces the maintenance-job control plane: every background routine that can
# run, write, spend, or mutate context must declare ownership, trigger, writes,
# log paths, guards, and failure policy.
node "$REPO_ROOT/scripts/check-background-routines.js" || { echo "pre-commit: background routine registry gate failed"; exit 1; }

# ── 2k4. Integration registration contract gate (st_fd14cdd4 AC4) ───────────
# Asserts the registry ↔ surface derivation bidirectionally (descriptor without
# a surface = red, surface off the registry = red) plus the OAuth-callback and
# typed-account contracts. tests/registration-contract.test.js proves the
# negative (a deliberate violation exits non-zero).
node "$REPO_ROOT/scripts/check-performance-memory-polish.js" || { echo "pre-commit: integration registration contract gate failed"; exit 1; }

# ── 2l. BB-files manifest gate (st_bc949e7c) ─────────────────────────────────
# config/bb-files.json declares the BB surfaces to remove on cohort-key
# soft-delete. Every listed bb_repo_paths entry must exist in the repo, or
# the soft-delete walk silently no-ops on a stale path. Validator runs here
# so typos are caught at commit time, not on a user's machine on grace day.
node "$REPO_ROOT/scripts/check-bb-files-manifest.js" || { echo "pre-commit: bb-files manifest gate failed"; exit 1; }

# ── 2m. AC/VC immutability gate (st_64d21872) ────────────────────────────────
# Backstops the ~/.claude/hooks/ac-guard.mjs PreToolUse hook by verifying that
# every sealed AC/VC artifact (scope/plan/criteria stage) staged in this commit
# matches its chain[stage].hash from stage-hashes.json — or has a matching
# amendments[].new_hash entry. Catches mutations that bypass the hook (e.g.,
# Bash constructs the hook's parser doesn't see, or Node writes invoked
# outside Claude's tool boundary). Default mode operates on `git diff --cached`
# only — pre-existing drift in non-staged files is reported separately via
# `node scripts/check-ac-immutability.js --all`.
node "$REPO_ROOT/scripts/check-ac-immutability.js" || { echo "pre-commit: ac-immutability gate failed"; exit 1; }

# ── 2n. Cross-terminal active-builds gate (st_64d21872) ──────────────────────
# Reads pipeline/active-builds.jsonl for active build claims from other Claude
# sessions; if this commit's staged files match another session's claim, the
# gate blocks. Stops the multi-terminal commit-scoop pattern that recurred in
# st_4e6e2ea9 / st_cfb2859e / st_64d21872. Bypass: ROBOTDOJO_SKIP_ACTIVE_BUILDS_CHECK=1.
node "$REPO_ROOT/scripts/check-active-builds.js" || { echo "pre-commit: active-builds gate failed"; exit 1; }

# ── Legal page date injection (st_ba0a385d) ──────────────────────────────────
# When a legal page is staged, auto-updates "Last updated:" body text and
# JSON-LD dateModified to today's date and re-stages. Fires only for staged
# legal pages — never as a side effect on unrelated commits.
if git diff --cached --name-only | grep -qE '^apps/(privacy|terms|licensing)\.html$'; then
  node "$REPO_ROOT/scripts/update-legal-dates.js" || { echo "pre-commit: legal date injection failed"; exit 1; }
fi

# ── 3. FAQ bundle ────────────────────────────────────────────────────────────
# Pre-commit does not regenerate or stage FAQ bundles. Run explicitly:
#   node scripts/bundle-faq.js
