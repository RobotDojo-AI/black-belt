# scripts/detax.sh — pre-commit de-tax (st_862d73d1 AC9, extracted from pre-commit.sh).
#
# The "de-tax" is the ONLY regenerate-and-stage logic in the commit hook: it
# regenerates the deterministic, owner-trusted projections of committed sources
# (sitemap, ontology, agent dist adapters, public-truth/faq/llms corpus) and
# stages exactly those — so a source edit that cascades into a generated doc
# commits with no manual regeneration step. pre-commit.sh `source`s this file;
# all CHECK-only gates stay inline in pre-commit.sh (this file never gates).
#
# Contract (do not break — detax-public-truth.test.js extracts and runs this
# file standalone in a temp repo):
#   - References only $REPO_ROOT (set by the caller / the test wrapper).
#   - `set -u`-safe: DETAX_STORY is guarded with ${...:-} everywhere.
#   - generate-public-truth.js is NOT wrapped in `|| true` — its banned-copy
#     throw MUST still abort the commit.
#   - apps/index.html hand-authored marketing copy is NEVER auto-staged.
#     Generator-owned FAQ + belt-price stamps inside that file ARE staged when
#     they are the only delta (see indexHtmlDiffIsGeneratorOwned).
#   - Imports bootstrapDeterministicCommit from scripts/root-lock-lib.js so the
#     just-staged protected outputs get a meta.touches + approval refresh and
#     check-root-lock (inline in pre-commit) does not block on a blob the de-tax
#     itself produced. Safe: a deterministic regen is a byte-exact projection of
#     committed sources, not a hand-edit.

# ── 0pre. Regenerate maps BEFORE public-truth ────────────────────────────────
# public-truth embeds sitemap.md + ontology.md sha256 into llms.txt, so the maps
# must be fresh first; else a structural commit leaves llms.txt with a stale map
# sha → drift meta-test + CI red. Idempotent; `|| true` so it never blocks.
node "$REPO_ROOT/scripts/generate-sitemap.js" --write >/dev/null 2>&1 || true
node "$REPO_ROOT/scripts/generate-ontology.js" --write >/dev/null 2>&1 || true

# ── 0. De-tax: regenerate + stage faq-bundle + public-truth ──────────────────
# Resolve the active story ONCE, INSIDE this block so it stays self-contained
# under `set -u`. Build skill exports ROBOTDOJO_ACTIVE_STORY; a plain commit
# falls back to active-story.js. Empty → bootstrap skips, check-root-lock
# enforces the manual path. Block B reuses this value later in the same shell.
DETAX_STORY="${ROBOTDOJO_ACTIVE_STORY:-}"
if [ -z "${DETAX_STORY:-}" ]; then
  DETAX_STORY=$(node "$REPO_ROOT/scripts/active-story.js" 2>/dev/null || echo "")
fi

# SAFETY: the generator runs ONCE and is NOT wrapped in `|| true` — its
# assertNoBannedPublicCopy throw must still abort the commit.
if ! node "$REPO_ROOT/scripts/generate-public-truth.js"; then
  echo "[pre-commit] generate-public-truth.js failed (banned public copy or generator error) — commit aborted." >&2
  exit 1
fi
for f in \
  lib/public-chat/public-truth.js \
  lib/public-chat/faq-bundle.js \
  apps/static/public-truth.json \
  apps/static/faq-data.json \
  apps/static/llms.txt \
  apps/static/llms-full.txt; do
  git -C "$REPO_ROOT" diff --quiet -- "$f" || git -C "$REPO_ROOT" add "$f" 2>/dev/null || true
done
# Legacy per-category FAQ JSON (apps/static/faq/*.json) — deterministic too.
git -C "$REPO_ROOT" diff --quiet -- 'apps/static/faq/*.json' \
  || git -C "$REPO_ROOT" add 'apps/static/faq/*.json' 2>/dev/null || true
# apps/index.html: stage only when the working-tree delta is confined to the
# generator-owned FAQ block and belt price stamps. A hand-authored copy edit
# anywhere else stays unstaged. The classifier lives in its own file so a
# fixture stub of generate-public-truth.js cannot swallow a real copy edit.
if [ -f "$REPO_ROOT/scripts/index-html-generator-owned.js" ] \
  && ! git -C "$REPO_ROOT" diff --quiet -- apps/index.html; then
  if node "$REPO_ROOT/scripts/index-html-generator-owned.js"; then
    git -C "$REPO_ROOT" add apps/index.html 2>/dev/null || true
  fi
fi

# Bootstrap the PROTECTED deterministic outputs we just auto-staged, keyed to
# DETAX_STORY. bootstrapDeterministicCommit does both halves — meta.touches
# injection + approval refresh — so check-root-lock below does not block on a
# blob the de-tax just produced. Skipped when no active story resolved.
if [ -n "${DETAX_STORY:-}" ]; then
  ROBOTDOJO_ACTIVE_STORY="$DETAX_STORY" node -e "
    import('$REPO_ROOT/scripts/root-lock-lib.js').then(m=>{
      m.bootstrapDeterministicCommit('$REPO_ROOT', [
        'lib/public-chat/public-truth.js','apps/static/public-truth.json',
        'apps/static/llms.txt','apps/static/llms-full.txt',
        'architecture/sitemap.md','architecture/ontology.md'
      ], { storyId: process.env.ROBOTDOJO_ACTIVE_STORY, ownerQuote: 'deterministic de-tax regeneration (owner sources)' });
    }).catch(()=>{});
  " 2>/dev/null || true
fi

# ── Pre-commit de-tax: auto-fix deterministic regenerable outputs ────────────
# Regenerate inline, then stage ONLY when bytes actually changed. The subsequent
# --check gates (inline in pre-commit.sh) then pass. Conditional staging (via
# `git diff --quiet`) means a no-op regen does not stage the file.
node "$REPO_ROOT/scripts/generate-sitemap.js" --write >/dev/null 2>&1 || true
git -C "$REPO_ROOT" diff --quiet -- architecture/sitemap.md \
  || git -C "$REPO_ROOT" add architecture/sitemap.md 2>/dev/null || true

node "$REPO_ROOT/scripts/generate-ontology.js" --write >/dev/null 2>&1 || true
git -C "$REPO_ROOT" diff --quiet -- architecture/ontology.md \
  || git -C "$REPO_ROOT" add architecture/ontology.md 2>/dev/null || true

node "$REPO_ROOT/scripts/generate-identity.js" >/dev/null 2>&1 || true
DIST_DELTA=0
git -C "$REPO_ROOT" diff --quiet -- agents/dist/ || DIST_DELTA=1
if [ "$DIST_DELTA" = "1" ]; then
  git -C "$REPO_ROOT" add agents/dist/ 2>/dev/null || true
fi

# Bootstrap block B's protected deterministic outputs (sitemap, ontology) into
# the active story's touches + approval, same as block A. `${DETAX_STORY:-}`
# keeps this set -u-safe even if this file is run standalone.
if [ -n "${DETAX_STORY:-}" ]; then
  ROBOTDOJO_ACTIVE_STORY="$DETAX_STORY" node -e "
    import('$REPO_ROOT/scripts/root-lock-lib.js').then(m=>{
      m.bootstrapDeterministicCommit('$REPO_ROOT', [
        'architecture/sitemap.md','architecture/ontology.md'
      ], { storyId: process.env.ROBOTDOJO_ACTIVE_STORY, ownerQuote: 'deterministic de-tax regeneration (owner sources)' });
    }).catch(()=>{});
  " 2>/dev/null || true
fi

# ── Adapter desync resync + notify ───────────────────────────────────────────
# ~/.claude/agents/*.md are SYMLINKS into agents/dist/claude-agents/, which the
# regen above rewrites in place. A content-only dist delta already reaches the
# live session on next spawn — notify only. But if the persona/skill SET changed
# (a basename added/removed), the symlink SET is now wrong and install-skills.sh
# must re-link. Decide by the ONE comparison: the claude-agents/*.md basename SET
# in dist vs the live ~/.claude/agents/ set.
if [ "${DIST_DELTA:-0}" = "1" ]; then
  SET_CHANGED=$(node -e "
    const fs=require('fs'); const p=require('path'); const os=require('os');
    const distDir=p.join('$REPO_ROOT','agents','dist','claude-agents');
    const liveDir=p.join(os.homedir(),'.claude','agents');
    const ls=d=>{ try { return new Set(fs.readdirSync(d).filter(f=>f.endsWith('.md'))); } catch { return new Set(); } };
    const dist=ls(distDir); const live=ls(liveDir);
    let changed=0;
    if (live.size>0) {
      for (const f of dist) if (!live.has(f)) changed=1;
      for (const f of live) if (!dist.has(f)) changed=1;
    }
    process.stdout.write(changed?'1':'0');
  " 2>/dev/null || echo "0")
  if [ "$SET_CHANGED" = "1" ]; then
    echo "[pre-commit] adapter set changed (persona/skill added or removed) — re-linking via install-skills.sh."
    bash "$REPO_ROOT/scripts/install-skills.sh" >/dev/null 2>&1 || echo "[pre-commit] install-skills.sh relink failed (continuing)."
    node "$REPO_ROOT/scripts/notify.js" "Adapter set changed mid-session — install-skills.sh re-linked specialists. Restart Claude Code (new terminal) to load the updated set." >/dev/null 2>&1 || true
  else
    node "$REPO_ROOT/scripts/notify.js" "Specialist persona bodies regenerated this commit — they take effect on the next subagent spawn. No action needed." >/dev/null 2>&1 || true
  fi
fi
