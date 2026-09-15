#!/usr/bin/env bash
set -u

REPO_URL="${ROBOTDOJO_REPO:-https://github.com/RobotDojo-AI/black-belt}"
# Prefer the live product home when set (installer / LaunchAgents use this).
REPO_DIR="${ROBOTDOJO_HOME:-$HOME/robotdojo}"
CLAUDE_SKILLS="$HOME/.claude/skills"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"

# SKILLS is derived from the canonical source dir after the repo is present
# (see below) — never a hardcoded list. A hardcoded list silently drops new
# skills (df_5dfe81b8: `promote` was missing, so its adapter went stale and
# uncaught). Deriving from agents/skills/*/SKILL.md keeps coverage exact.
SKILLS=""

DRY_RUN=0
CHECK_ONLY=0
CLI_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --check-only) CHECK_ONLY=1 ;;
    --cli-only) CLI_ONLY=1 ;;
  esac
done

install_robotdojo_cli() {
  local dest_dir="${HOME}/.local/bin"
  mkdir -p "$dest_dir"
  ln -sfn "$REPO_DIR/scripts/robotdojo.js" "$dest_dir/robotdojo"
  chmod +x "$REPO_DIR/scripts/robotdojo.js"
}

# --check-only: print status and exit
if [ "$CHECK_ONLY" = "1" ]; then
  echo "robotdojo install-skills.sh — checking prerequisites"
  echo "REPO_URL: $REPO_URL"
  echo "REPO_DIR: $REPO_DIR"
  node --version >/dev/null 2>&1 && echo "Node: $(node --version)" || echo "Node: not found"
  [ -d "$REPO_DIR" ] && echo "~/robotdojo: present" || echo "~/robotdojo: not present (will sparse-clone)"
  exit 0
fi

if [ "$CLI_ONLY" = "1" ]; then
  if [ ! -f "$REPO_DIR/scripts/robotdojo.js" ]; then
    echo "Error: $REPO_DIR/scripts/robotdojo.js missing" >&2
    exit 1
  fi
  install_robotdojo_cli
  echo "robotdojo -> $HOME/.local/bin/robotdojo"
  exit 0
fi

# Node version check
NODE_MAJOR=$(node -e 'process.stdout.write(process.version.split(".")[0].slice(1))' 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt "20" ] 2>/dev/null; then
  echo "Error: Node 20+ required (found: $(node --version 2>/dev/null || echo 'none'))" >&2
  echo "Install from https://nodejs.org/ or via: brew install node@20" >&2
  exit 1
fi

# Clone if not present (sparse — agents, scripts, pipeline only)
if [ ! -d "$REPO_DIR" ]; then
  echo "Cloning $REPO_URL (sparse — agents + scripts only)..."
  git clone --filter=blob:none --sparse "$REPO_URL" "$REPO_DIR"
  git -C "$REPO_DIR" sparse-checkout set agents scripts pipeline
fi

# npm install (idempotent). AC9 (st_a5baa72c): a DEV checkout commits, and the
# pre-commit gates (check-registry-schema.js → import Ajv) need gate
# dependencies that arrive transitively through devDependencies (stryker).
# `--omit=dev` prunes them and the FIRST pre-commit gate then crashes. So in a
# dev checkout we run a FULL install (no --omit=dev); a fresh end-user SPARSE
# clone never commits and never runs the gates, so it keeps --omit=dev to stay
# lean. Detect a dev checkout by either signal: an installed pre-commit hook OR
# a non-sparse tests/ directory (the sparse end-user clone only checks out
# agents/, scripts/, pipeline/). Note: ajv is now also a declared production
# dependency (package.json), so the gate is resilient even if stryker drops it
# — but a dev checkout still needs the full devDependency set for the suite.
if [ "$DRY_RUN" = "0" ]; then
  if [ -f "$REPO_DIR/.git/hooks/pre-commit" ] || [ -d "$REPO_DIR/tests" ]; then
    echo "Installing dependencies (dev checkout — full install, gates need dev deps)..."
    npm install --prefix "$REPO_DIR" --silent
  else
    echo "Installing dependencies (end-user clone — production only)..."
    npm install --omit=dev --prefix "$REPO_DIR" --silent
  fi
fi

# Wrap CLI — same command the owner types in a terminal.
if [ "$DRY_RUN" = "0" ]; then
  install_robotdojo_cli
fi

# Derive the skill set from the canonical source dir — exact coverage, no
# hardcoded list to drift behind newly added skills.
SKILLS=$(for d in "$REPO_DIR"/agents/skills/*/SKILL.md; do
  [ -f "$d" ] && basename "$(dirname "$d")"
done | sort | tr '\n' ' ')

# Create skill symlinks
mkdir -p "$CLAUDE_SKILLS"
for skill in $SKILLS; do
  SRC="$REPO_DIR/agents/skills/$skill/SKILL.md"
  DEST_DIR="$CLAUDE_SKILLS/$skill"
  if [ "$DRY_RUN" = "1" ]; then
    echo "Would link: $DEST_DIR/SKILL.md -> $SRC"
    continue
  fi
  [ -f "$SRC" ] || { echo "Warning: $SRC not found — skipping $skill" >&2; continue; }
  # Remove old directory symlink if present (Claude Code can't follow dir symlinks for skill scanning)
  [ -L "$DEST_DIR" ] && rm -f "$DEST_DIR"
  mkdir -p "$DEST_DIR"
  ln -snf "$SRC" "$DEST_DIR/SKILL.md"
  echo "Linked: $skill"
done

# Retired names stay as repo stubs so old invocations redirect. Host copies
# of those names must not linger as first-class skills.
RETIRED_SKILLS="work health coach"
for skill in $RETIRED_SKILLS; do
  for host_dir in "$HOME/.claude/skills" "$HOME/.agents/skills"; do
    if [ -e "$host_dir/$skill" ] || [ -L "$host_dir/$skill" ]; then
      if [ "$DRY_RUN" = "1" ]; then
        echo "Would retire host skill: $host_dir/$skill"
      else
        rm -rf "$host_dir/$skill"
        echo "Retired host skill: $host_dir/$skill"
      fi
    fi
  done
done

if [ "$DRY_RUN" = "1" ]; then
  exit 0
fi

# Agent OS: generate adapters, then install live symlinks for every host.
# WHY: lines below reference $ROOT. Under `set -u` an unset $ROOT crashes.
ROOT="$REPO_DIR"

# Mine conversation telemetry → memory feedback → standing corrections, then
# bake into identity adapters. Best-effort: mining never blocks install.
if [ -f "$ROOT/scripts/mine-conversation-feedback.js" ]; then
  echo "Mining conversation feedback into standing corrections..."
  node "$ROOT/scripts/mine-conversation-feedback.js" --no-identity || \
    echo "Warning: conversation mine skipped (non-fatal)" >&2
fi

node "$ROOT/scripts/generate-identity.js"

# ── Claude Code ────────────────────────────────────────────────────────────
# Full bootstrap via @-import of dist/claude.md (contains Miyagi + standing
# corrections). Replace empty "BEGIN robotdojo-identity" stubs so hosts that
# only inject the block still get a pointer to the real file.
mkdir -p "$HOME/.claude"
touch "$CLAUDE_MD"
IMPORT1="@~/robotdojo/agents/dist/claude.md"
IMPORT2="@~/robotdojo/agents/build-conventions.md"
IMPORT3="@~/robotdojo/config/agent-voice/standing-corrections.md"
grep -qF "$IMPORT1" "$CLAUDE_MD" || echo "$IMPORT1" >> "$CLAUDE_MD"
grep -qF "$IMPORT2" "$CLAUDE_MD" || echo "$IMPORT2" >> "$CLAUDE_MD"
grep -qF "$IMPORT3" "$CLAUDE_MD" || echo "$IMPORT3" >> "$CLAUDE_MD"
# Rewrite empty identity block if present (placeholder from old installs).
if grep -q 'BEGIN robotdojo-identity' "$CLAUDE_MD" 2>/dev/null; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    let s = fs.readFileSync(p, "utf8");
    const re = /<!-- BEGIN robotdojo-identity -->[\s\S]*?<!-- END robotdojo-identity -->/;
    const block = [
      "<!-- BEGIN robotdojo-identity -->",
      "<!-- Managed by install-skills.sh — full OS at agents/dist/claude.md -->",
      "Default agent: Miyagi. Load standing corrections + persona before substantive work.",
      "fuck/fucking = failure telemetry. 10/10 before friend testing. Same feedback twice = encode it.",
      "Full identity: @~/robotdojo/agents/dist/claude.md",
      "Standing corrections: @~/robotdojo/config/agent-voice/standing-corrections.md",
      "<!-- END robotdojo-identity -->",
    ].join("\n");
    if (re.test(s)) s = s.replace(re, block);
    fs.writeFileSync(p, s);
  ' "$CLAUDE_MD"
fi

mkdir -p "$HOME/.claude/agents" "$HOME/.claude/rules"
ln -snf "$ROOT/agents/dist/claude.md" "$HOME/.claude/rules/robotdojo-identity.md"
for f in "$ROOT"/agents/dist/claude-agents/*.md; do
  [ -f "$f" ] || continue
  ln -snf "$f" "$HOME/.claude/agents/$(basename "$f")"
done

# ── Codex ──────────────────────────────────────────────────────────────────
mkdir -p "$HOME/.codex"
ln -snf "$ROOT/agents/dist/AGENTS.md" "$HOME/.codex/AGENTS.md"

# ── Cursor ─────────────────────────────────────────────────────────────────
mkdir -p "$HOME/.cursor/rules"
ln -snf "$ROOT/agents/dist/cursor-identity.mdc" "$HOME/.cursor/rules/identity.mdc"
ln -snf "$ROOT/agents/dist/cursor-memory.mdc" "$HOME/.cursor/rules/memory.mdc"

# ── Grok Build ─────────────────────────────────────────────────────────────
# Grok loads ~/.grok/rules/*.md for every project, plus AGENTS.md in the tree.
# Symlink the full bootstrap so Grok never gets an empty identity stub.
mkdir -p "$HOME/.grok/rules"
ln -snf "$ROOT/agents/dist/grok.md" "$HOME/.grok/rules/robotdojo-identity.md"
ln -snf "$ROOT/config/agent-voice/standing-corrections.md" "$HOME/.grok/rules/standing-corrections.md"
# Generated feedback bullets (gitignored dist) when present
if [ -f "$ROOT/agents/dist/standing-corrections.generated.md" ]; then
  ln -snf "$ROOT/agents/dist/standing-corrections.generated.md" "$HOME/.grok/rules/standing-corrections.generated.md"
fi
# Home-level Agents.md (Grok/Codex when cwd is $HOME): replace broken
# identity/dist pointers with live agents/dist imports.
HOME_AGENTS="$HOME/Agents.md"
if [ -f "$HOME_AGENTS" ] || [ ! -e "$HOME_AGENTS" ]; then
  cat > "$HOME_AGENTS" <<EOF
<!-- Robot Dojo Agent OS — managed by install-skills.sh. Do not hand-edit the identity block. -->

<!-- identity:import -->
@~/robotdojo/agents/dist/AGENTS.md
<!-- /identity:import -->

<!-- standing-corrections:import -->
@~/robotdojo/config/agent-voice/standing-corrections.md
<!-- /standing-corrections:import -->

<!-- build-conventions:import -->
@~/robotdojo/agents/build-conventions.md
<!-- /build-conventions:import -->

<!-- memory:pointer -->
Memory log: ~/robotdojo/user/memory/log/ (Merkle-chained, append-only). Query on-demand:
- \`node ~/robotdojo/scripts/memory-search.js <keyword>\` — keyword search across entry bodies
- After a correction: append feedback memory, then \`node ~/robotdojo/scripts/build-standing-corrections.js && node ~/robotdojo/scripts/generate-identity.js\`
<!-- /memory:pointer -->

<!-- BEGIN robotdojo-identity -->
Default agent: Miyagi. Standing corrections are law. fuck/fucking = failure telemetry.
Full OS: ~/robotdojo/agents/dist/AGENTS.md (also ~/.grok/rules/robotdojo-identity.md).
<!-- END robotdojo-identity -->
EOF
  echo "Wrote $HOME_AGENTS → agents/dist/AGENTS.md"
fi

# Project-level AGENTS.md inside robotdojo for Grok/Codex when cwd is the repo
if [ -d "$ROOT" ]; then
  ln -snf "$ROOT/agents/dist/AGENTS.md" "$ROOT/AGENTS.md"
fi

# Self-verify: every adapter must now be a live symlink to canonical, no
# strays, dist headers present, source→dist fresh. check-agent-os.js is the
# unified gate. If this fails, the install did not take — surface it.
if [ -f "$ROOT/scripts/check-agent-os.js" ]; then
  node "$ROOT/scripts/check-agent-os.js" || {
    echo "Error: agent OS install failed the unified drift check (see above)." >&2
    exit 1
  }
fi

if [ -f "$ROOT/scripts/install-writing-freeze.js" ]; then
  node "$ROOT/scripts/install-writing-freeze.js" || echo "install-writing-freeze: completed with host gaps"
fi

echo ""
echo "Done. Restart Claude Code / Grok / Cursor sessions to load identity."
echo "  Claude:  ~/.claude/rules/robotdojo-identity.md + CLAUDE.md imports"
echo "  Codex:   ~/.codex/AGENTS.md"
echo "  Cursor:  ~/.cursor/rules/identity.mdc + memory.mdc"
echo "  Grok:    ~/.grok/rules/robotdojo-identity.md + ~/Agents.md"
echo "  Learn:   node ~/robotdojo/scripts/mine-conversation-feedback.js"
