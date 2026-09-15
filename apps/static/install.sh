#!/usr/bin/env bash
# shellcheck shell=bash
#
# Robot Dojo — one-command installer
#
#   curl -fsSL https://robotdojo.ai/install.sh | bash
#
# Clones the repo, installs dependencies, bootstraps config, runs migrations,
# installs a service (launchd on macOS), and opens the local Account
# Integrations page plus setup-aware chat in the default browser.
#
# Idempotent: safe to re-run (offers upgrade path on existing install).
# Privacy-first: no telemetry, all logging is local.
#
# Environment overrides:
#   ROBOTDOJO_HOME              — install dir (default: ~/robotdojo)
#   ROBOTDOJO_CONFIG            — config dir  (default: ~/.robotdojo)
#   ROBOTDOJO_REPO              — git repo URL (default: https://github.com/RobotDojo-AI/black-belt.git)
#   ROBOTDOJO_BRANCH            — branch (default: main)
#   ROBOTDOJO_NO_OPEN=1         — skip opening browser at the end
#   ROBOTDOJO_NO_OPEN_PERMISSIONS=1 — skip opening macOS Full Disk Access
#   ROBOTDOJO_NO_SERVICE=1      — skip installing the background service
#   ROBOTDOJO_DRY_RUN=1         — print every side-effect command instead of executing it
#                                 (test-only: stubs launchctl, security, mkcert, plist writes).
#   ROBOTDOJO_KEYCHAIN_PREFIX   — prefix prepended to every robotdojo-* Keychain
#                                 service name (default: empty). Tests set
#                                 ROBOTDOJO_KEYCHAIN_PREFIX=test- so they never
#                                 touch the operator's real Keychain entries.
#
set -euo pipefail

# --- Constants -----------------------------------------------------------

ROBOTDOJO_HOME="${ROBOTDOJO_HOME:-$HOME/robotdojo}"
ROBOTDOJO_CONFIG="${ROBOTDOJO_CONFIG:-$HOME/.robotdojo}"
# WHY: public repo at the RobotDojo-AI org. Older personal repo paths are not
# customer-installable and may 404 for strangers — st_42799dbe AC 1.
ROBOTDOJO_REPO="${ROBOTDOJO_REPO:-https://github.com/RobotDojo-AI/black-belt.git}"
ROBOTDOJO_BRANCH="${ROBOTDOJO_BRANCH:-main}"

APP_PORT=4338
SITE_PORT=4336
PRODUCT_ORIGIN="${ROBOTDOJO_PRODUCT_ORIGIN:-https://robotdojo.ai}"
MIN_NODE_MAJOR=20
MIN_DISK_MB=8000
LOCAL_EMBED_MODEL_ID="Snowflake/snowflake-arctic-embed-l-v2.0"

# WHY com.robotdojo.server: every product LaunchAgent shares the
# `com.robotdojo.*` namespace (st_bc949e7c). The actual install loop is
# manifest-driven (config/launch-agents.json); this constant remains only
# for the legacy uninstall path that targets the single pre-rename plist.
LAUNCHD_LABEL="com.robotdojo.server"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
LAUNCH_AGENTS_MANIFEST="$ROBOTDOJO_HOME/config/launch-agents.json"
LAUNCH_AGENTS_TEMPLATE_DIR="$ROBOTDOJO_HOME/apps/static/launch-agents"
SYSTEMD_UNIT_DIR="$HOME/.config/systemd/user"
SYSTEMD_UNIT_NAME="robotdojo.service"
SYSTEMD_UNIT_PATH="${SYSTEMD_UNIT_DIR}/${SYSTEMD_UNIT_NAME}"
ROBOTDOJO_PERMISSION_APP_DIR="${ROBOTDOJO_PERMISSION_APP_DIR:-$HOME/Applications}"
ROBOTDOJO_PERMISSION_APP="${ROBOTDOJO_PERMISSION_APP:-$ROBOTDOJO_PERMISSION_APP_DIR/Robot Dojo.app}"
ROBOTDOJO_PERMISSION_LAUNCHER="${ROBOTDOJO_PERMISSION_LAUNCHER:-$ROBOTDOJO_CONFIG/bin/Robot Dojo}"
ROBOTDOJO_RUNTIME_BIN="${ROBOTDOJO_RUNTIME_BIN:-}"

# Dry-run + Keychain-prefix flags (test-only side-effect isolation).
# WHY: install.sh side-effects (launchctl load, security add-generic-password,
# mkcert -install, mkcert -cert-file, plist writes) overwrite the operator's
# real running system on every invocation. Tests must be able to enumerate
# the side-effect set without firing them. ROBOTDOJO_DRY_RUN=1 echoes a
# `DRY: <command>` line in place of each side-effect; ROBOTDOJO_KEYCHAIN_PREFIX
# namespaces every robotdojo-* Keychain service so a test run never collides
# with live secrets (root cause: st_5a63545d's first llm-key test overwrote
# the operator's real ANTHROPIC_API_KEY by hitting the route via app.fetch()).
ROBOTDOJO_DRY_RUN="${ROBOTDOJO_DRY_RUN:-0}"
ROBOTDOJO_KEYCHAIN_PREFIX="${ROBOTDOJO_KEYCHAIN_PREFIX:-}"
INTEGRATIONS_HANDOFF_URL=""
CHAT_HANDOFF_URL=""
RELAY_READY_URL=""
RELAY_GATEWAY_URL="${ROBOTDOJO_GATEWAY_URL:-https://relay.robotdojo.ai}"
RELAY_BOOTSTRAP_SECRET="${ROBOTDOJO_RELAY_BOOTSTRAP_SECRET:-}"
ROBOTDOJO_OWNER_EMAIL_VALUE=""

# Dojo-address (subdomain) selection state. DOJO_SLUG_CHOSEN=1 means the operator
# picked their `${slug}.robotdojo.ai` name up front (prompt_dojo_slug), which is
# then authoritative — setup_device_name must not overwrite it and
# ensure_relay_identity must not silently auto-suffix it. RELAY_PROVISION_BG_STARTED=1
# means start_relay_warmup_bg already kicked off the Cloudflare tunnel + edge-cert
# warmup in the background, so main() waits for the run-token instead of
# provisioning a second tunnel.
DOJO_SLUG_CHOSEN=0
RELAY_PROVISION_BG_STARTED=0

# Local TLS — mkcert provisions a browser-trusted cert covering localhost
# (st_bc949e7c AC 11). install.sh writes both files; lib/gateway-tls.js#
# getLocalhostCertPaths() reads them at server boot and the index.js SNI
# handler routes localhost traffic to them.
LOCALHOST_TLS_DIR="$ROBOTDOJO_CONFIG/tls"
LOCALHOST_CERT_PATH="$LOCALHOST_TLS_DIR/localhost.crt"
LOCALHOST_KEY_PATH="$LOCALHOST_TLS_DIR/localhost.key"

# dry-run guard. `run_or_dry <human-readable-command-string> <actual-command>`
# echoes `DRY: <human-readable-command-string>` when ROBOTDOJO_DRY_RUN=1,
# otherwise eval-executes the actual command. The human-readable string is
# the load-bearing identifier in VC7 — it must contain the launchctl label
# (or equivalent) verbatim so the parity grep can count plist installs
# without parsing the args array.
run_or_dry() {
  local label="$1"
  shift
  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    printf 'DRY: %s\n' "$label"
  else
    "$@"
  fi
}

# --- Colors + UI --------------------------------------------------------

if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[0;31m'
  C_GREEN=$'\033[0;32m'
  C_YELLOW=$'\033[0;33m'
  C_BLUE=$'\033[0;34m'
  C_BOLD=$'\033[1m'
else
  C_RESET=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""
fi

ok()   { printf "  %s✓%s %s\n" "$C_GREEN" "$C_RESET" "$1"; }
info() { printf "  %s•%s %s\n" "$C_BLUE" "$C_RESET" "$1"; }
warn() { printf "  %s!%s %s\n" "$C_YELLOW" "$C_RESET" "$1" >&2; }
err()  { printf "  %s✗ %s%s\n" "$C_RED" "$1" "$C_RESET" >&2; }
step() { printf "\n%s%s%s\n" "$C_BOLD" "$1" "$C_RESET"; }

die() {
  err "$1"
  if [[ -n "${2:-}" ]]; then
    printf "\n  %sHow to fix:%s %s\n\n" "$C_BOLD" "$C_RESET" "$2" >&2
  fi
  exit 1
}

logo() {
  cat <<'EOF'

      ____        __          __     ____        _
     / __ \____  / /_  ____  / /_   / __ \____  (_)___
    / /_/ / __ \/ __ \/ __ \/ __/  / / / / __ \/ / __ \
   / _, _/ /_/ / /_/ / /_/ / /_   / /_/ / /_/ / / /_/ /
  /_/ |_|\____/_.___/\____/\__/  /_____/\____/_/\____/

EOF
  printf "  Personal AI operating system. Your data. Your machine.\n"
  printf "  %shttps://robotdojo.ai%s\n\n" "$C_DIM" "$C_RESET"
}

# --- Platform detection --------------------------------------------------

detect_os() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)  echo "linux" ;;
    MINGW*|CYGWIN*|MSYS*) echo "windows" ;;
    *)      echo "unknown" ;;
  esac
}

OS="$(detect_os)"

if [[ "$OS" == "windows" ]]; then
  cat >&2 <<EOF

Robot Dojo v1 does not natively support Windows.

Please install via WSL2:
  1. Open PowerShell as admin: wsl --install
  2. Reboot, open Ubuntu
  3. Re-run: curl -fsSL https://robotdojo.ai/install.sh | bash

Docker support is on the roadmap.

EOF
  exit 1
fi

if [[ "$OS" == "unknown" ]]; then
  die "Unsupported OS: $(uname -s)" "Robot Dojo supports macOS and Linux only."
fi

# --- Preflight checks ---------------------------------------------------

check_command() {
  command -v "$1" >/dev/null 2>&1
}

keychain_service() {
  printf '%srobotdojo-%s' "$ROBOTDOJO_KEYCHAIN_PREFIX" "$1"
}

read_keychain_secret() {
  local name="$1"
  if [[ "$OS" != "macos" || "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    return 1
  fi
  security find-generic-password -s "$(keychain_service "$name")" -w 2>/dev/null || return 1
}

write_keychain_secret() {
  local name="$1"
  local value="$2"
  local service
  service="$(keychain_service "$name")"
  if [[ "$OS" != "macos" ]]; then
    warn "${name}: Keychain write skipped on ${OS}"
    return 1
  fi
  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    printf 'DRY: security add-generic-password -s %s -a %s -w <value>\n' \
      "$service" "${USER:-robotdojo}"
    return 0
  fi
  security add-generic-password \
    -s "$service" \
    -a "${USER:-robotdojo}" \
    -w "$value" \
    -U >/dev/null 2>&1
}

urlencode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""))' "$1"
}

# --- Homebrew auto-install (macOS) ---------------------------------------
#
# WHY osascript + Terminal.app spawn instead of inline curl|bash:
# Homebrew's installer prompts for the sudo password interactively, which
# does not work inside a curl|bash pipe (no TTY). Detaching the Homebrew
# install to a real Terminal.app window gives the user a working sudo
# prompt; we then wait for `brew` to appear in PATH before continuing.
#
# Fallback path: if osascript or Terminal.app are unavailable (rare on
# macOS but possible on locked-down systems), print the exact command
# the user should run and exit with a clear error. Never strand the
# install on a stuck state — researched in 01-research.md as the known
# failure mode for curl|bash Homebrew installs.

ensure_homebrew_macos() {
  if [[ "$OS" != "macos" ]]; then
    return 0
  fi
  if check_command brew; then
    ok "Homebrew $(brew --version | head -1 | awk '{print $2}') found"
    return 0
  fi

  info "Homebrew not installed — launching auto-install in a new Terminal window"
  info "(Homebrew needs an interactive sudo prompt, which doesn't work inside a curl|bash pipe)"

  local sentinel
  sentinel="$(mktemp -t robotdojo-brew-done.XXXXXX)"
  rm -f "$sentinel"

  # AppleScript escaping: single quotes in the AppleScript string are fine
  # inside the bash heredoc, but the inner shell command we pass into the
  # Terminal window must end with `touch $sentinel; exit` so we can detect
  # completion from this parent process.
  local install_cmd="/bin/bash -c \\\"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\\\" && touch $sentinel; exit"

  if ! check_command osascript; then
    warn "osascript not available — can't auto-spawn Terminal"
    printf "\n  %sRun this command in a new Terminal window, then re-run install:%s\n" "$C_BOLD" "$C_RESET"
    printf "    /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"\n\n"
    die "Homebrew install requires interactive sudo" "See above."
  fi

  osascript -e "tell application \"Terminal\" to do script \"$install_cmd\"" >/dev/null 2>&1 || {
    warn "Failed to spawn Terminal — falling back to manual instructions"
    printf "\n  %sRun this command in a new Terminal window, then re-run install:%s\n" "$C_BOLD" "$C_RESET"
    printf "    /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"\n\n"
    die "Homebrew install spawn failed" "See above."
  }

  info "Waiting for Homebrew install to complete in the new Terminal window..."
  # 15-minute timeout — Homebrew install on slow machines can take >10 minutes
  local waited=0
  while (( waited < 900 )); do
    if [[ -f "$sentinel" ]]; then
      break
    fi
    sleep 5
    waited=$((waited + 5))
  done
  rm -f "$sentinel"

  # Re-source the shell so brew enters $PATH (Homebrew installer appends to
  # ~/.zprofile / ~/.bash_profile but the running shell doesn't see it).
  if [[ -d /opt/homebrew/bin ]]; then
    export PATH="/opt/homebrew/bin:$PATH"
  elif [[ -d /usr/local/bin ]]; then
    export PATH="/usr/local/bin:$PATH"
  fi

  if ! check_command brew; then
    die "Homebrew install did not finish" \
        "Open a new Terminal and run: brew --version. If it works, re-run this installer."
  fi
  ok "Homebrew installed ($(brew --version | head -1))"
}

# --- Ollama install + RAM-based model pull -------------------------------
#
# WHY delegate to ollama.com/install.sh: their install handles Gatekeeper
# signing, /Applications placement, the menu-bar app, login items, and
# /usr/local/bin/ollama symlink. We never re-implement what they maintain.
#
# WHY sysctl -n hw.memsize: verified live on Apple Silicon (research note);
# returns total physical RAM in bytes with no sudo. The threshold is 16 GB:
# below that, gemma3:4b (3.3 GB on disk) is the safer fit; at or above,
# qwen2.5:7b (4.7 GB, better instruction following) is preferred.

ensure_ollama_macos() {
  if [[ "$OS" != "macos" ]]; then
    return 0
  fi
  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: ensure_ollama_macos skipped"
    return 0
  fi

  # Detect total physical RAM in GB. hw.memsize is bytes; integer-divide
  # twice (KB → MB → GB) to avoid rounding error on odd-sized machines.
  local ram_bytes ram_gb
  ram_bytes="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  ram_gb=$(( ram_bytes / 1024 / 1024 / 1024 ))

  local model expected_size
  if (( ram_gb >= 16 )); then
    model="qwen2.5:7b"
    expected_size="~4.7 GB"
  else
    model="gemma3:4b"
    expected_size="~3.3 GB"
  fi

  if ! check_command ollama; then
    info "Installing Ollama (local model runtime) via official installer..."
    if ! curl -fsSL https://ollama.com/install.sh | sh; then
      err "Ollama install failed"
      printf "\n  %sDownload Ollama manually:%s https://ollama.com/download\n\n" "$C_BOLD" "$C_RESET"
      die "Ollama install did not complete" "Install Ollama manually, then re-run."
    fi
    ok "Ollama installed"
  else
    ok "Ollama $(ollama --version 2>/dev/null || echo installed) found"
  fi

  # Start Ollama if not running (it's a menu-bar app on macOS).
  if ! curl -sf --max-time 2 http://localhost:11434/api/tags >/dev/null 2>&1; then
    info "Starting Ollama background service..."
    open -a Ollama --args hidden 2>/dev/null || true
    sleep 3
  fi

  # Pull the model. ollama renders its own animated progress — we just print
  # an explanatory header so the user knows what's downloading and why.
  if ollama list 2>/dev/null | awk '{print $1}' | grep -qx "$model"; then
    ok "Ollama model $model already present"
    OLLAMA_MODEL="$model"
    return 0
  fi
  info "Detected ${ram_gb} GB of RAM — pulling $model ($expected_size download)"
  info "This is your free local AI model. It runs entirely on your Mac, no internet needed after the download."
  if ! ollama pull "$model"; then
    warn "Ollama model pull failed — chat will still work via a cloud API key"
    return 0
  fi
  ok "Ollama model $model ready"
  OLLAMA_MODEL="$model"
}

check_node() {
  if ! check_command node; then
    return 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if (( major < MIN_NODE_MAJOR )); then
    return 2
  fi
  return 0
}

install_node_macos() {
  info "Installing Node.js via nvm (macOS)..."
  if ! check_command curl; then
    die "curl is required but not installed" "Install curl and re-run."
  fi
  # Install nvm to ~/.nvm (if not already)
  if [[ ! -d "$HOME/.nvm" ]]; then
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh" | bash
  fi
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  [[ -s "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"
  nvm install "$MIN_NODE_MAJOR"
  nvm use "$MIN_NODE_MAJOR"
  nvm alias default "$MIN_NODE_MAJOR"
}

install_node_linux() {
  info "Installing Node.js ≥${MIN_NODE_MAJOR} (Linux)..."
  if check_command apt-get; then
    # NodeSource for Debian/Ubuntu
    curl -fsSL "https://deb.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  elif check_command dnf; then
    curl -fsSL "https://rpm.nodesource.com/setup_${MIN_NODE_MAJOR}.x" | sudo -E bash -
    sudo dnf install -y nodejs
  elif check_command pacman; then
    sudo pacman -Sy --noconfirm nodejs npm
  else
    die "No supported package manager found (apt, dnf, pacman)" \
        "Install Node.js ≥${MIN_NODE_MAJOR} manually, then re-run."
  fi
}

preflight() {
  step "1/8  Preflight checks"

  # Node.js
  local node_status=0
  check_node || node_status=$?
  case "$node_status" in
    0) ok "Node.js $(node --version) found" ;;
    1) warn "Node.js not installed — installing..."
       if [[ "$OS" == "macos" ]]; then install_node_macos; else install_node_linux; fi
       ok "Node.js $(node --version) installed" ;;
    2) warn "Node.js $(node --version) too old — installing ≥${MIN_NODE_MAJOR}..."
       if [[ "$OS" == "macos" ]]; then install_node_macos; else install_node_linux; fi
       ok "Node.js $(node --version) installed" ;;
  esac

  # npm (bundled with node, but verify)
  check_command npm || die "npm not found after Node install" "Re-install Node.js from https://nodejs.org"
  ok "npm $(npm --version) found"

  # git
  if ! check_command git; then
    if [[ "$OS" == "macos" ]]; then
      die "git is not installed" "Install Xcode CLI tools: xcode-select --install"
    else
      die "git is not installed" "Install with: sudo apt-get install git (or your distro equivalent)"
    fi
  fi
  ok "git $(git --version | awk '{print $3}') found"

  # Xcode CLI tools (macOS only — required for the better-sqlite3 native build).
  # WHY a hard die, not a warning: install_deps (step 3/8) runs `npm ci`, which
  # compiles the better-sqlite3 / better-sqlite3-multiple-ciphers native modules.
  # Without the Command Line Tools that compile fails partway, leaving a half-
  # installed tree. Stop up front with a fix instead of crashing mid-build.
  if [[ "$OS" == "macos" ]]; then
    if ! xcode-select -p >/dev/null 2>&1; then
      die "Xcode Command Line Tools are required to build native modules" \
          "Run: xcode-select --install  — accept the prompt, let it finish, then re-run this installer."
    fi
    ok "Xcode Command Line Tools found"
  fi

  # Disk space
  local free_mb
  if [[ "$OS" == "macos" ]]; then
    free_mb="$(df -m "$HOME" | awk 'NR==2 {print $4}')"
  else
    free_mb="$(df -m --output=avail "$HOME" | awk 'NR==2 {print $1}')"
  fi
  if (( free_mb < MIN_DISK_MB )); then
    die "Insufficient disk space: ${free_mb}MB free, ${MIN_DISK_MB}MB required" \
        "Free up space and re-run."
  fi
  ok "Disk space: ${free_mb}MB free"

  # Ports
  check_port_free "$APP_PORT"  "app"
  check_port_free "$SITE_PORT" "site"
}

check_port_free() {
  local port="$1" name="$2"
  if port_in_use "$port"; then
    # Check if it's our own already-running service — that's fine, we'll restart it
    if service_is_ours; then
      ok "Port $port ($name) in use by existing Robot Dojo (will restart)"
      return 0
    fi
    die "Port $port ($name) is already in use by another process" \
        "Stop the other process or set PORT_APP/PORT_SITE env vars."
  fi
  ok "Port $port ($name) free"
}

port_in_use() {
  local port="$1"
  if check_command lsof; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif check_command ss; then
    ss -ltn "sport = :$port" 2>/dev/null | grep -q ":$port"
  elif check_command netstat; then
    netstat -tln 2>/dev/null | grep -q ":$port "
  else
    # Can't check — assume free and hope for the best
    return 1
  fi
}

service_is_ours() {
  if [[ "$OS" == "macos" ]]; then
    [[ -f "$LAUNCHD_PLIST" ]]
  else
    [[ -f "$SYSTEMD_UNIT_PATH" ]]
  fi
}

# --- Clone / update repo ------------------------------------------------

clone_repo() {
  step "2/8  Clone repo"

  # Dry-run skips clone — tests stage the repo tree in $ROBOTDOJO_HOME
  # directly so the install_launch_agents loop has a manifest to walk.
  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: git clone $ROBOTDOJO_REPO -> $ROBOTDOJO_HOME"
    return 0
  fi

  if [[ -d "$ROBOTDOJO_HOME/.git" ]]; then
    info "Existing install detected at ${ROBOTDOJO_HOME}"
    if [[ -t 0 ]]; then
      printf "  %sUpgrade (git pull) or abort?%s [U/a] " "$C_BOLD" "$C_RESET"
      read -r reply </dev/tty || reply="U"
    else
      info "Non-interactive shell — defaulting to upgrade"
      reply="U"
    fi
    case "$reply" in
      [Aa]*) die "Aborted by user" "Remove $ROBOTDOJO_HOME manually to reinstall." ;;
      *)     info "Pulling latest from $ROBOTDOJO_BRANCH..."
             git -C "$ROBOTDOJO_HOME" fetch --depth 1 origin "$ROBOTDOJO_BRANCH"
             git -C "$ROBOTDOJO_HOME" reset --hard "origin/$ROBOTDOJO_BRANCH"
             ok "Updated to $(git -C "$ROBOTDOJO_HOME" rev-parse --short HEAD)" ;;
    esac
  else
    info "Cloning $ROBOTDOJO_REPO → $ROBOTDOJO_HOME"
    git clone --depth 1 --branch "$ROBOTDOJO_BRANCH" "$ROBOTDOJO_REPO" "$ROBOTDOJO_HOME"
    ok "Cloned to $ROBOTDOJO_HOME"
  fi
}

# --- Install dependencies -----------------------------------------------

install_deps() {
  step "3/8  Install dependencies"

  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: npm ci (skip)"
    return 0
  fi

  cd "$ROBOTDOJO_HOME"
  info "Running npm ci --omit=dev (this may take a minute)..."
  if ! npm ci --omit=dev --no-audit --no-fund 2>&1 | sed 's/^/    /'; then
    # npm ci fails if no package-lock.json — fall back to npm install
    warn "npm ci failed, falling back to npm install"
    npm install --omit=dev --no-audit --no-fund 2>&1 | sed 's/^/    /'
  fi
  ok "Dependencies installed ($(find node_modules -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ') packages)"
}

# Black Belt Build layer: link portable agent skills/personas into the coding
# agent homes (Claude Code / Codex / Cursor). Non-fatal — product chat works
# without this; friends re-run scripts/install-skills.sh if it fails.
install_agent_os() {
  step "Agent OS (Build skills)"

  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: bash scripts/install-skills.sh"
    return 0
  fi

  local script="$ROBOTDOJO_HOME/scripts/install-skills.sh"
  if [[ ! -f "$script" ]]; then
    warn "install-skills.sh not found — Build skills not linked"
    return 0
  fi

  cd "$ROBOTDOJO_HOME"
  if ROBOTDOJO_HOME="$ROBOTDOJO_HOME" bash "$script" 2>&1 | sed 's/^/    /'; then
    ok "Agent OS skills and adapters linked"
  else
    warn "Agent OS skill install had issues — chat still works; re-run: bash $script"
  fi
}

ensure_local_embedding_model() {
  step "Install local embedding model"

  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: node scripts/setup/prewarm-local-embeddings.js"
    return 0
  fi

  cd "$ROBOTDOJO_HOME"
  info "Downloading ${LOCAL_EMBED_MODEL_ID} (quantized, ~540 MB). This is the $0 RAG model and runs on this Mac."
  if ! ROBOTDOJO_CONFIG="$ROBOTDOJO_CONFIG" node scripts/setup/prewarm-local-embeddings.js 2>&1 | sed 's/^/    /'; then
    die "Local embedding model download failed" "Check your internet connection, then re-run the installer."
  fi
  ok "Local embedding model ready"
}

# --- Dojo address (subdomain) -------------------------------------------
#
# Ask for the dojo's public subdomain FIRST, before the heavy install steps.
# The dojo lives at `${slug}.robotdojo.ai`; capturing it up front lets
# start_relay_warmup_bg provision the Cloudflare tunnel + DNS and warm
# Cloudflare's per-hostname edge certificate in the background while npm ci, the
# embedding-model download, and migrations run — so the ~90s edge-cert warmup is
# already done by the time the browser opens.
#
# RESERVED_SLUGS_BASH + validate_slug MIRROR validateRelaySlug / RESERVED_SLUGS
# in lib/user-identity.js (the SOURCE OF TRUTH — keep them in sync). Same rules:
# lowercase a-z / 0-9 / hyphen, 3-32 chars, no leading/trailing/double hyphen,
# not a reserved infra name. This is a pure string check only — global hostname
# uniqueness is still enforced by Cloudflare/the relay at provision time, never
# here.
RESERVED_SLUGS_BASH="www api app mail send smtp imap pop mx ns ns1 ns2 dojo relay connect admin root ftp cdn static assets blog docs status dashboard login auth account accounts staging dev test vercel cloudflare _dmarc autoconfig autodiscover"

# validate_slug <input> — sets VALIDATED_SLUG (normalized) on success and
# SLUG_ERROR (human reason) on failure; returns 0/1. Mirror of validateRelaySlug
# in lib/user-identity.js.
validate_slug() {
  local s="$1"
  # Mirror JS String(slug).trim().toLowerCase(): trim leading/trailing
  # whitespace ONLY (internal whitespace must fail the charset rule, exactly as
  # it does in the JS validator), then lowercase.
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  s="$(printf '%s' "$s" | tr '[:upper:]' '[:lower:]')"
  VALIDATED_SLUG=""
  if [[ -z "$s" ]]; then SLUG_ERROR="Subdomain is required."; return 1; fi
  if (( ${#s} < 3 || ${#s} > 32 )); then SLUG_ERROR="Use 3 to 32 characters."; return 1; fi
  if [[ ! "$s" =~ ^[a-z0-9-]+$ ]]; then SLUG_ERROR="Use only lowercase letters, digits, and hyphens."; return 1; fi
  if [[ "$s" == -* || "$s" == *- ]]; then SLUG_ERROR="Cannot start or end with a hyphen."; return 1; fi
  if [[ "$s" == *--* ]]; then SLUG_ERROR="No double hyphens."; return 1; fi
  local r
  for r in $RESERVED_SLUGS_BASH; do
    if [[ "$s" == "$r" ]]; then SLUG_ERROR="\"$s\" is reserved. Pick another."; return 1; fi
  done
  VALIDATED_SLUG="$s"
  SLUG_ERROR=""
  return 0
}

# persist_chosen_slug <slug> — record the operator's chosen dojo address so the
# rest of the flow (resolve_relay_slug, ensure_relay_identity,
# provision_cloudflare_tunnel, open_browser) all agree on it. Reuses the same
# Keychain entry + initial-slug file the installer already used.
persist_chosen_slug() {
  local slug="$1"
  mkdir -p "$ROBOTDOJO_CONFIG"
  chmod 700 "$ROBOTDOJO_CONFIG" 2>/dev/null || true
  printf '%s' "$slug" > "$ROBOTDOJO_CONFIG/initial-slug"
  chmod 600 "$ROBOTDOJO_CONFIG/initial-slug" 2>/dev/null || true
  write_keychain_secret "ROBOTDOJO_DEVICE_SLUG" "$slug" || true
  DOJO_SLUG="$slug"
  DOJO_SLUG_CHOSEN=1
}

prompt_dojo_slug() {
  step "Choose your dojo address"

  # Dry-run mocks every side effect and has no TTY — skip and let the existing
  # device-name default (setup_device_name) drive the slug. Never hang.
  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: prompt_dojo_slug skipped (device-name default used)"
    return 0
  fi

  # Preset / scripted install: `DOJO_SLUG=my-dojo bash install.sh`. Validate and
  # use it without prompting. Invalid preset is a hard stop with the reason.
  if [[ -n "${DOJO_SLUG:-}" ]]; then
    if validate_slug "$DOJO_SLUG"; then
      persist_chosen_slug "$VALIDATED_SLUG"
      ok "Dojo address: https://${VALIDATED_SLUG}.robotdojo.ai"
      return 0
    fi
    die "DOJO_SLUG=\"$DOJO_SLUG\" is not a valid dojo address: $SLUG_ERROR" \
        "Re-run with a valid name, e.g. DOJO_SLUG=my-dojo bash install.sh"
  fi

  # Interactive only when a real controlling terminal is reachable. `curl | bash`
  # pipes the script over stdin, so read from /dev/tty — but only if it opens.
  # No terminal (headless / piped, no DOJO_SLUG) => fall back to the device-name
  # default and never block.
  if [[ ! -e /dev/tty ]] || ! (exec </dev/tty) 2>/dev/null; then
    info "No terminal available to choose an address — using this computer's name by default."
    info "You can change it anytime from Account settings."
    return 0
  fi

  info "This is the private web address you'll use to reach your dojo from anywhere:"
  info "    https://<name>.robotdojo.ai"
  info "Pick something short and memorable: lowercase letters, numbers, and hyphens."
  info "You can change it anytime from Account settings."

  local input
  while true; do
    printf "  %sYour dojo address:%s " "$C_BOLD" "$C_RESET" > /dev/tty
    if ! read -r input < /dev/tty; then
      info "No input received — using this computer's name by default."
      return 0
    fi
    if validate_slug "$input"; then
      persist_chosen_slug "$VALIDATED_SLUG"
      ok "Dojo address: https://${VALIDATED_SLUG}.robotdojo.ai"
      return 0
    fi
    warn "$SLUG_ERROR"
  done
}

# --- Owner identity (df_cbd30a5a) ---------------------------------------
#
# Capture the owner's CANONICAL identity — name + hard identifiers (emails,
# optional phone) — into the declared-owner block of identity.json, through the
# single writer lib/identity.js#writeDeclaredOwner (never a raw file write, so
# the NOT-NULL analog + cache reset are enforced). Runs before the server's
# first ingest so the owner-anchor guard is armed on first run: no contact card
# can rename the owner or absorb another established person into him.
#
# Idempotent + preserve-existing: a complete declared block is kept untouched.
# Non-interactive / preset path: ROBOTDOJO_OWNER_NAME + ROBOTDOJO_OWNER_EMAILS
# (comma-separated) + optional ROBOTDOJO_OWNER_PHONES. Dry-run with no presets
# skips (no prompt, never hangs); the preset path still writes so tests can
# drive it under ROBOTDOJO_DRY_RUN=1.
declared_owner_write() {
  # $1=name  $2=comma-emails  $3=comma-phones
  ROBOTDOJO_OWNER_NAME="$1" ROBOTDOJO_OWNER_EMAILS="$2" ROBOTDOJO_OWNER_PHONES="$3" \
  node -e '
    import("./lib/identity.js").then((m) => {
      const name = (process.env.ROBOTDOJO_OWNER_NAME || "").trim();
      const emails = (process.env.ROBOTDOJO_OWNER_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
      const phones = (process.env.ROBOTDOJO_OWNER_PHONES || "").split(",").map((s) => s.trim()).filter(Boolean);
      m.writeDeclaredOwner({ name, emails, phones, declared_source: "installer" });
      console.log("declared");
    }).catch((e) => { console.error(e.message); process.exit(1); });
  '
}

prompt_owner_identity() {
  step "Your identity"

  if ! check_command node; then
    info "node unavailable — skipping owner identity capture (set it later with @miyagi)."
    return 0
  fi

  # Already declared → preserve untouched.
  if node -e 'import("./lib/identity.js").then((m) => process.exit(m.isOwnerDeclared() ? 0 : 1)).catch(() => process.exit(1))' >/dev/null 2>&1; then
    info "Owner identity already set — preserving it."
    return 0
  fi

  # Preset / scripted path (also the test path under ROBOTDOJO_DRY_RUN=1).
  if [[ -n "${ROBOTDOJO_OWNER_NAME:-}" && -n "${ROBOTDOJO_OWNER_EMAILS:-}" ]]; then
    if declared_owner_write "$ROBOTDOJO_OWNER_NAME" "$ROBOTDOJO_OWNER_EMAILS" "${ROBOTDOJO_OWNER_PHONES:-}" >/dev/null; then
      ok "Owner identity recorded: $ROBOTDOJO_OWNER_NAME"
      return 0
    fi
    warn "Owner identity not recorded (need a name and at least one valid email) — set it later with @miyagi."
    return 0
  fi

  # Dry-run with no presets — never prompt/hang.
  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: prompt_owner_identity skipped (no preset owner name/emails)."
    return 0
  fi

  # No controlling terminal — skip gracefully (set later with @miyagi).
  if [[ ! -e /dev/tty ]] || ! (exec </dev/tty) 2>/dev/null; then
    info "No terminal to capture your identity — you can set it anytime by telling @miyagi your name and emails."
    return 0
  fi

  info "So the assistant always knows YOU are you, tell it your name and your email addresses."
  info "This is the one identity it will never confuse with anyone else. You can update it later with @miyagi."

  local owner_name="" owner_emails=""
  printf "  %sYour full name:%s " "$C_BOLD" "$C_RESET" > /dev/tty
  read -r owner_name < /dev/tty || { info "No input — set your identity later with @miyagi."; return 0; }
  printf "  %sYour email addresses (comma-separated):%s " "$C_BOLD" "$C_RESET" > /dev/tty
  read -r owner_emails < /dev/tty || { info "No input — set your identity later with @miyagi."; return 0; }

  if [[ -z "${owner_name// }" || "$owner_emails" != *"@"* ]]; then
    warn "Need a name and at least one email with an @ — skipping for now. Set it later with @miyagi."
    return 0
  fi
  if declared_owner_write "$owner_name" "$owner_emails" "" >/dev/null; then
    ok "Owner identity recorded: $owner_name"
  else
    warn "Owner identity not recorded — set it later with @miyagi."
  fi
}

# --- Device name --------------------------------------------------------

setup_device_name() {
  step "4/8  This Mac"

  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    DOJO_SLUG="dryrun-slug"
    DEVICE_NAME="Dry Run Mac"
    info "DRY: setup_device_name skipped (DEVICE_NAME=Dry Run Mac)"
    return 0
  fi

  DEVICE_NAME="$(scutil --get ComputerName 2>/dev/null || scutil --get LocalHostName 2>/dev/null || hostname -s 2>/dev/null || echo "This Mac")"

  mkdir -p "$ROBOTDOJO_CONFIG"
  chmod 700 "$ROBOTDOJO_CONFIG"
  printf '%s' "$DEVICE_NAME" > "$ROBOTDOJO_CONFIG/device-name"
  chmod 600 "$ROBOTDOJO_CONFIG/device-name"
  ok "This Mac: $DEVICE_NAME"

  # A dojo address chosen up front (prompt_dojo_slug) is authoritative — keep it
  # and do NOT overwrite the persisted initial-slug with a device-derived name.
  if [[ "${DOJO_SLUG_CHOSEN:-0}" = "1" ]]; then
    info "Dojo address: https://${DOJO_SLUG}.robotdojo.ai (chosen earlier; change it anytime from Account)"
    return 0
  fi

  info "No dojo address was chosen, so Robot Dojo will use this Mac's name by default."
  info "You can rename it later from Account if the name is generic."

  DOJO_SLUG="$(printf '%s' "$DEVICE_NAME" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/\.local$//' \
    | sed 's/[^a-z0-9]/-/g' \
    | sed 's/-\+/-/g' \
    | sed "s/^-\|-\$//g" \
    | cut -c1-32)"

  case "$DOJO_SLUG" in
    api|auth|static|chat|ask|login|logout|signup|\
    account|accounts|me|install|uninstall|\
    onboarding|onboarding-share|setup|admin|\
    public-chat|network|pulse|files|billing|payments|\
    health|timeline|referrals|invite|\
    root|system|support|help|status|ping|\
    white|black|sensei|dojo-team|robotdojo|\
    dev|staging|prod|test|local|localhost|null)
      DOJO_SLUG=""
      ;;
  esac

  if ! echo "$DOJO_SLUG" | grep -qE '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$'; then
    DOJO_SLUG="this-mac"
  fi

  printf '%s' "$DOJO_SLUG" > "$ROBOTDOJO_CONFIG/initial-slug"
  chmod 600 "$ROBOTDOJO_CONFIG/initial-slug"
  ok "Saved device name for first-run setup"
}

# --- Bootstrap config ---------------------------------------------------
#
# Detect-and-preserve: if $ROBOTDOJO_CONFIG already contains user-authored
# content (key, identity, contexts, taxonomy, settings), we keep every one
# of those files untouched and only fill in what's missing. This is what
# makes the installer safe to re-run AND safe for operator migrations
# (see docs/migration-plan.md).
#
# Files / dirs that must be preserved when present:
#   - key                   (Black Belt subscription key)
#   - key.meta.json         (belt metadata; may contain "permanent": true)
#   - identity.json         (owner emails, owner_person_id, display_name)
#   - identity/             (markdown identity files: IDENTITY.md, SOUL.md, …)
#   - contexts/*.md         (per-topic context docs authored by the user)
#   - taxonomy.user.json    (user's T1/T2 topic tree)
#   - user-settings.json    (preferences: tone, coaching, theme, timezone)

bootstrap_config() {
  step "5/8  Bootstrap config"

  mkdir -p "$ROBOTDOJO_CONFIG" "$ROBOTDOJO_CONFIG/logs"
  chmod 700 "$ROBOTDOJO_CONFIG"

  # Announce what we're preserving vs what we're creating fresh.
  preserve_existing_config

  # Bootstrap-time autogenerated secrets — Keychain only, no flat files.
  # WHY in Keychain (not files): lib/config.js#secret() reads exclusively from
  # the Keychain at runtime. The pre-st_5a63545d flat-file auth path is dead;
  # first-run auth no longer requires a manual Keychain seed. Each ensure_*
  # helper is idempotent: skip-and-preserve on existing entries so re-runs
  # and migrations do not regenerate live secrets (which would invalidate
  # active sessions).
  ensure_keychain_secret "SESSION_SECRET"
  ensure_keychain_secret "ROBOTDOJO_AUTH_TOKEN"

  # st_d142f701 AC1: OAuth credential seeding.
  # WHY in install.sh: routes/oauth.js returns 503 when GOOGLE_CLIENT_ID /
  # GOOGLE_CLIENT_SECRET / MICROSOFT_CLIENT_ID / MICROSOFT_TENANT_ID are
  # missing from the Keychain. Without seeding here, a fresh user clicks
  # "Connect Google" or "Connect Microsoft" on the accounts page and hits
  # a 503 JSON body — the documented launch blocker.
  # WHY warn-and-continue (not fail): users who skip OAuth still complete
  # the install. We surface a warning that directs them to set the env
  # vars and re-run, or connect later from the accounts page.
  # Caller contract: set ROBOTDOJO_GOOGLE_CLIENT_ID, ROBOTDOJO_GOOGLE_CLIENT_SECRET,
  # ROBOTDOJO_REDIRECT_BASE, ROBOTDOJO_MICROSOFT_CLIENT_ID, ROBOTDOJO_MICROSOFT_TENANT_ID
  # before invoking the installer. Use `export` in a sub-shell to keep
  # values out of shell history.
  ensure_keychain_from_env "GOOGLE_CLIENT_ID"       "ROBOTDOJO_GOOGLE_CLIENT_ID"
  ensure_keychain_from_env "GOOGLE_CLIENT_SECRET"   "ROBOTDOJO_GOOGLE_CLIENT_SECRET"
  ensure_keychain_from_env "REDIRECT_BASE"          "ROBOTDOJO_REDIRECT_BASE"
  ensure_keychain_from_env "MICROSOFT_CLIENT_ID"    "ROBOTDOJO_MICROSOFT_CLIENT_ID"
  ensure_keychain_from_env "MICROSOFT_TENANT_ID"    "ROBOTDOJO_MICROSOFT_TENANT_ID"

  # Config file
  local config_file="$ROBOTDOJO_CONFIG/config.json"
  local bb_expires_at
  if [[ ! -f "$config_file" ]]; then
    # st_96bb626f AC 13: stamp the Black Belt beta clock at first install.
    # getBBStatus() folds this local expiry into the entitlement gate, so the
    # 90-day window is anchored to *this* install. BSD `date -u -v+90d` — the
    # installer targets Apple-Silicon macOS.
    bb_expires_at="$(date -u -v+90d +%Y-%m-%dT%H:%M:%SZ)"
    # Private beta: Black Belt engines on for 90 days (bb_expires_at). White is
    # the post-expiry floor; first install should feel like "knows your world".
    cat > "$config_file" <<EOF
{
  "belt": "black",
  "home": "$ROBOTDOJO_HOME",
  "db_path": "$ROBOTDOJO_CONFIG/robotdojo.db",
  "ports": { "app": $APP_PORT, "site": $SITE_PORT },
  "installed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "bb_expires_at": "$bb_expires_at"
}
EOF
    chmod 600 "$config_file"
    ok "Config written → ${config_file}"
  else
    # Backfill bb_expires_at for machines installed before the 90-day clock
    # existed: anchor to the existing installed_at (per-install semantics),
    # falling back to now when it is absent. Idempotent — only writes when the
    # field is missing, so a re-run never slides the expiry forward.
    if [[ "$ROBOTDOJO_DRY_RUN" != "1" ]] && check_command node; then
      ROBOTDOJO_CONFIG_JSON_PATH="$config_file" node -e '
        const fs = require("fs");
        const p = process.env.ROBOTDOJO_CONFIG_JSON_PATH;
        let cfg;
        try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch { process.exit(0); }
        if (cfg.bb_expires_at) process.exit(0);
        const base = cfg.installed_at ? new Date(cfg.installed_at) : new Date();
        const anchor = Number.isNaN(base.getTime()) ? new Date() : base;
        const exp = new Date(anchor.getTime() + 90 * 86400 * 1000);
        cfg.bb_expires_at = exp.toISOString().replace(/\.\d{3}Z$/, "Z");
        fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
      ' 2>/dev/null || true
    fi
    ok "Config already present"
  fi

  # Local DB encryption key — lives in the macOS Keychain (Linux uses env
  # var or a key file; we only auto-generate on macOS). On re-installs /
  # migrations we leave the existing entry alone so prior-DB encryption
  # still decrypts.
  ensure_local_db_key

  # Anthropic key detection
  local key_found=0
  if [[ -n "${ANTHROPIC_API_KEY:-}" ]]; then
    ok "ANTHROPIC_API_KEY found in environment"
    key_found=1
  elif [[ "$OS" == "macos" ]] && [[ "$ROBOTDOJO_DRY_RUN" != "1" ]] && security find-generic-password -s "${ROBOTDOJO_KEYCHAIN_PREFIX}robotdojo-ANTHROPIC_API_KEY" -w >/dev/null 2>&1; then
    ok "ANTHROPIC_API_KEY found in macOS Keychain"
    key_found=1
  fi
  if (( key_found == 0 )); then
    warn "ANTHROPIC_API_KEY not set — the chat will prompt you to add one during onboarding"
  fi
}

# Announce every user-authored file / dir we're preserving. Purely read-only —
# this does not create or mutate anything.
preserve_existing_config() {
  local -a preserved=()

  # Single-file preservation targets.
  local f
  for f in key key.meta.json identity.json taxonomy.user.json user-settings.json; do
    if [[ -e "$ROBOTDOJO_CONFIG/$f" ]]; then
      preserved+=("$f")
    fi
  done

  # Identity markdown directory (IDENTITY.md, SOUL.md, USER.md, etc.).
  if [[ -d "$ROBOTDOJO_CONFIG/identity" ]]; then
    local id_count
    id_count=$(find "$ROBOTDOJO_CONFIG/identity" -maxdepth 1 -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
    if (( id_count > 0 )); then
      preserved+=("identity/ (${id_count} docs)")
    else
      preserved+=("identity/")
    fi
  fi

  # Context docs directory (per-topic markdown, authored by the user).
  if [[ -d "$ROBOTDOJO_CONFIG/contexts" ]]; then
    local ctx_count
    ctx_count=$(find "$ROBOTDOJO_CONFIG/contexts" -maxdepth 1 -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
    if (( ctx_count > 0 )); then
      preserved+=("contexts/ (${ctx_count} docs)")
    fi
  fi

  if (( ${#preserved[@]} > 0 )); then
    local joined="" sep=""
    local p
    for p in "${preserved[@]}"; do
      joined+="${sep}${p}"
      sep=", "
    done
    ok "preserved existing: ${joined}"
  fi
}

# Generic Keychain secret seeder. Idempotent: skip if already present so
# re-runs and migrations never regenerate a live secret (rotating would
# invalidate every active session and AUTH_TOKEN-authenticated client).
# Generates 32 bytes of base64-encoded entropy via `openssl rand -base64 32`
# — matches lib/session.js's secretOrThrow() minimum + AC 2 contract.
ensure_keychain_secret() {
  local name="$1"
  local service="${ROBOTDOJO_KEYCHAIN_PREFIX}robotdojo-${name}"
  if [[ "$OS" != "macos" ]]; then
    info "${name}: macOS-only auto-generation skipped on ${OS}"
    return 0
  fi
  # Existence check — if already in Keychain AND ≥32 bytes, preserve.
  # Skipped in dry-run because we never WANT to read the operator's real
  # Keychain from a test harness — pretend the slot is empty and echo a
  # DRY add line so the parity grep observes the write side-effect.
  if [[ "$ROBOTDOJO_DRY_RUN" != "1" ]]; then
    local existing
    existing="$(security find-generic-password -s "$service" -w 2>/dev/null || true)"
    if [[ -n "$existing" ]] && (( ${#existing} >= 32 )); then
      ok "${name}: already in Keychain (preserved)"
      return 0
    fi
  fi
  if ! check_command openssl; then
    warn "${name}: openssl not available, skipping — set ${name} manually"
    return 0
  fi
  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    printf 'DRY: security add-generic-password -s %s -a %s -w <random>\n' \
      "$service" "${USER:-robotdojo}"
    ok "${name}: dry-run (would generate and store in Keychain as ${service})"
    return 0
  fi
  local secret_value
  secret_value="$(openssl rand -base64 32)"
  # st_96bb626f AC 16: prefix ONLY the pasted bearer token so every issued
  # ROBOTDOJO_AUTH_TOKEN is recognisable as rdj-…. SESSION_SECRET and the DB
  # keys share this generic helper and must stay unprefixed — they are never
  # user-pasted, and a prefixed session/DB secret would break login or DB open.
  [[ "$name" == "ROBOTDOJO_AUTH_TOKEN" ]] && secret_value="rdj-${secret_value}"
  security add-generic-password \
    -s "$service" \
    -a "${USER:-robotdojo}" \
    -w "$secret_value" \
    -U >/dev/null 2>&1
  unset secret_value
  ok "${name}: generated and stored in Keychain"
}

# st_d142f701 AC1: seed an OAuth credential from a caller-provided env var.
# Idempotent: skip if already present in the Keychain (existing OAuth creds
# survive re-installs and migrations). Warn-and-continue when the env var
# is unset so users without OAuth credentials can still complete the install.
#
# WHY env-var-driven (not interactive prompt): the installer runs from a
# curl|bash pipe with no TTY. Env vars are the only credential channel
# that works in both pipe and interactive shells. Caller must `export`
# the values in a sub-shell to keep them out of shell history.
ensure_keychain_from_env() {
  local name="$1"
  local env_var="$2"
  local service="${ROBOTDOJO_KEYCHAIN_PREFIX}robotdojo-${name}"
  if [[ "$OS" != "macos" ]]; then
    info "${name}: macOS-only Keychain seeding skipped on ${OS}"
    return 0
  fi
  if [[ "$ROBOTDOJO_DRY_RUN" != "1" ]]; then
    local existing
    existing="$(security find-generic-password -s "$service" -w 2>/dev/null || true)"
    if [[ -n "$existing" ]]; then
      ok "${name}: already in Keychain (preserved)"
      return 0
    fi
  fi
  # Indirect env-var lookup — bash 3.2 compatible (no namerefs).
  local value="${!env_var:-}"
  if [[ -z "$value" ]]; then
    warn "${name}: ${env_var} not set — connect from the accounts page later (or re-run installer with ${env_var}=...)"
    return 0
  fi
  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    printf 'DRY: security add-generic-password -s %s -a %s -w <from %s>\n' \
      "$service" "${USER:-robotdojo}" "$env_var"
    ok "${name}: dry-run (would seed from ${env_var})"
    return 0
  fi
  # Value passed via -w argv — no shell expansion, no log echo.
  security add-generic-password \
    -s "$service" \
    -a "${USER:-robotdojo}" \
    -w "$value" \
    -U >/dev/null 2>&1
  unset value
  ok "${name}: seeded from ${env_var}"
}

# Local DB encryption key (macOS Keychain). Idempotent: if the entry already
# exists we leave it alone so an existing encrypted DB still decrypts on a
# re-install. Linux installs rely on ROBOTDOJO_DB_KEY env var or a secret
# manager — we only generate on macOS.
ensure_local_db_key() {
  local service="${ROBOTDOJO_KEYCHAIN_PREFIX}robotdojo-LOCAL_DB_KEY"
  if [[ "$OS" != "macos" ]]; then
    info "LOCAL_DB_KEY: macOS-only auto-generation skipped on ${OS}"
    return 0
  fi
  if [[ "$ROBOTDOJO_DRY_RUN" != "1" ]]; then
    if security find-generic-password -s "$service" -w >/dev/null 2>&1; then
      ok "LOCAL_DB_KEY: already in Keychain (preserved)"
      return 0
    fi
  fi
  if ! check_command openssl; then
    warn "LOCAL_DB_KEY: openssl not available, skipping — set ROBOTDOJO_DB_KEY manually"
    return 0
  fi
  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    printf 'DRY: security add-generic-password -s %s -a %s -w <random>\n' \
      "$service" "${USER:-robotdojo}"
    ok "LOCAL_DB_KEY: dry-run (would generate and store in Keychain as ${service})"
    return 0
  fi
  local db_key
  db_key="$(openssl rand -hex 32)"
  security add-generic-password \
    -s "$service" \
    -a "${USER:-robotdojo}" \
    -w "$db_key" \
    -U >/dev/null 2>&1
  unset db_key
  ok "LOCAL_DB_KEY: generated and stored in Keychain"
}

generate_secret_b64url() {
  if ! check_command openssl; then
    die "openssl is required for relay credentials" "Install openssl and re-run."
  fi
  openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
}

slugify_device_name() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/\.local$//' \
    | sed 's/[^a-z0-9]/-/g' \
    | sed 's/-\+/-/g' \
    | sed "s/^-\|-\$//g" \
    | cut -c1-32
}

ensure_relay_identity() {
  step "Relay identity"

  local slug secret bootstrap
  slug="$(read_keychain_secret "ROBOTDOJO_DEVICE_SLUG" || true)"
  if [[ -z "$slug" ]]; then
    slug="${DOJO_SLUG:-$(slugify_device_name "${DEVICE_NAME:-This Mac}")}"
    write_keychain_secret "ROBOTDOJO_DEVICE_SLUG" "$slug" || true
  fi

  secret="$(read_keychain_secret "ROBOTDOJO_DEVICE_SECRET" || true)"
  if [[ -z "$secret" ]]; then
    secret="$(generate_secret_b64url)"
    write_keychain_secret "ROBOTDOJO_DEVICE_SECRET" "$secret" || true
  fi

  # st_63b59bda AC-5: the relay identifies this Mac by its device secret alone.
  # No owner email is generated, stored for, or sent to the relay any longer.

  bootstrap="${RELAY_BOOTSTRAP_SECRET:-$(read_keychain_secret "ROBOTDOJO_RELAY_BOOTSTRAP_SECRET" || true)}"
  if [[ -n "${ROBOTDOJO_RELAY_BOOTSTRAP_SECRET:-}" ]]; then
    write_keychain_secret "ROBOTDOJO_RELAY_BOOTSTRAP_SECRET" "$ROBOTDOJO_RELAY_BOOTSTRAP_SECRET" || true
  fi
  # Local-first product: missing bootstrap is local-only, not install failure.
  # Remote access is optional Black Belt / invite path — friends must reach
  # Chat on localhost without operator Cloudflare or bootstrap secrets.
  if [[ -z "$bootstrap" ]]; then
    warn "No relay bootstrap secret — continuing local-only at https://localhost:${APP_PORT}"
    warn "Remote access can be added later from Account with a beta invite token."
    ok "Relay skipped (local-only install)"
    return 0
  fi

  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: register relay identity at ${RELAY_GATEWAY_URL}/api/register-device with x-robotdojo-bootstrap"
    ok "Relay identity ready"
    return 0
  fi

  local attempt=0 base_slug="$slug" status payload response tmp_slug suffix
  while (( attempt < 5 )); do
    payload="$(node -e '
      const [slug,secret] = process.argv.slice(1);
      process.stdout.write(JSON.stringify({ slug, deviceSecret: secret }));
    ' "$slug" "$secret")"
    response="$(curl --connect-timeout 5 -sS -w '\n%{http_code}' \
      -H 'content-type: application/json' \
      -H "x-robotdojo-bootstrap: $bootstrap" \
      -d "$payload" \
      "${RELAY_GATEWAY_URL%/}/api/register-device" 2>/dev/null || printf '\n000')"
    status="$(printf '%s' "$response" | tail -n 1)"
    if [[ "$status" = "200" ]]; then
      printf '%s' "$slug" > "$ROBOTDOJO_CONFIG/initial-slug"
      chmod 600 "$ROBOTDOJO_CONFIG/initial-slug"
      write_keychain_secret "ROBOTDOJO_DEVICE_SLUG" "$slug" || true
      ok "Relay identity ready for this Mac"
      return 0
    fi
    if [[ "$status" != "409" ]]; then
      warn "Relay registration failed (HTTP ${status}) — continuing local-only"
      warn "Check network or re-run with a valid ROBOTDOJO_RELAY_BOOTSTRAP_SECRET for remote access."
      ok "Relay skipped (local-only install)"
      return 0
    fi
    # A user who explicitly chose their dojo address keeps it or picks another
    # deliberately — never a silent auto-suffix. The chosen name is the one the
    # background tunnel + edge-cert warmup already used, so silently renaming
    # here would strand remote access on a different hostname.
    if [[ "${DOJO_SLUG_CHOSEN:-0}" = "1" ]]; then
      warn "The dojo address \"${base_slug}.robotdojo.ai\" is already taken — continuing local-only"
      warn "Re-run with a different DOJO_SLUG when you want remote access."
      ok "Relay skipped (local-only install)"
      return 0
    fi
    suffix="$(generate_secret_b64url | cut -c1-4 | tr '[:upper:]' '[:lower:]')"
    tmp_slug="$(printf '%s-%s' "$base_slug" "$suffix" | cut -c1-32 | sed "s/-$//")"
    slug="$tmp_slug"
    attempt=$((attempt + 1))
  done

  warn "Could not claim a relay name — continuing local-only at https://localhost:${APP_PORT}"
  ok "Relay skipped (local-only install)"
  return 0
}

provision_device_tls() {
  step "Provision remote TLS cert"

  local bootstrap
  bootstrap="${RELAY_BOOTSTRAP_SECRET:-$(read_keychain_secret "ROBOTDOJO_RELAY_BOOTSTRAP_SECRET" || true)}"
  if [[ -z "$bootstrap" ]]; then
    warn "Remote access bootstrap token not configured — skipping remote TLS cert provisioning"
    return 0
  fi

  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: provision device TLS certificate through relay with x-robotdojo-bootstrap"
    return 0
  fi

  cd "$ROBOTDOJO_HOME"
  if ! node -e "import('./lib/gateway-tls.js').then(m => m.provisionCert()).then(r => process.exit(r ? 0 : 1)).catch(e => { console.error(e.message); process.exit(1); })"; then
    die "Remote TLS certificate provisioning failed" \
        "Robot Dojo could not create a browser-trusted certificate for this Mac. Re-run install after the relay is reachable."
  fi
  ok "Remote TLS cert ready"
}

# --- Cloudflare relay tunnel --------------------------------------------
#
# provision_cloudflare_tunnel: create a per-user *named* Cloudflare Tunnel plus
# the matching DNS CNAME under the robotdojo.ai zone, write the tunnel
# run-token under $ROBOTDOJO_CONFIG/cloudflared/, and load the `cloudflared`
# LaunchAgent so the dojo is reachable at {slug}.robotdojo.ai from any
# device (st_96bb626f AC 1 / Phase B).
#
# WHY a named remotely-managed tunnel (config_src=cloudflare): the tunnel config
# and credentials live server-side at Cloudflare, so `cloudflared` runs from a
# single token with no local ingress file to drift. One tunnel per install,
# named after the device slug.
#
# OPTIONAL operator path. Friends never receive CLOUDFLARE_* zone tokens.
# Primary remote access for private beta is the SNI passthrough path:
#   ensure_relay_identity (register-device + bootstrap) → provision_device_tls
#   (LE cert via gateway CF DNS-01) → tunnel-client in the server process.
# Named cloudflared tunnels remain available when operator zone creds are
# present (founder machine / infra). Missing creds soft-skip to local-only.
provision_cloudflare_tunnel() {
  step "Provision Cloudflare relay tunnel"

  local slug cf_token cf_account cf_zone hostname cfd_dir
  slug="$(resolve_relay_slug || true)"
  if [[ -z "$slug" ]]; then
    die "Cannot provision the relay tunnel without a device name" \
        "Relay identity must be registered first. Re-run the installer."
  fi

  cf_token="${CLOUDFLARE_API_TOKEN:-$(read_keychain_secret CLOUDFLARE_API_TOKEN 2>/dev/null || true)}"
  cf_account="${CLOUDFLARE_ACCOUNT_ID:-$(read_keychain_secret CLOUDFLARE_ACCOUNT_ID 2>/dev/null || true)}"
  cf_zone="${CLOUDFLARE_ZONE_ID:-$(read_keychain_secret CLOUDFLARE_ZONE_ID 2>/dev/null || true)}"
  if [[ -z "$cf_token" || -z "$cf_account" || -z "$cf_zone" ]]; then
    # Friends never receive operator Cloudflare zone tokens. Local install
    # must succeed; remote tunnel is optional operator/infra path.
    warn "Cloudflare relay credentials not configured — skipping tunnel (local-only)"
    warn "Local app: https://localhost:${APP_PORT}"
    ok "Cloudflare tunnel skipped (local-only install)"
    return 0
  fi

  hostname="${slug}.robotdojo.ai"
  cfd_dir="$ROBOTDOJO_CONFIG/cloudflared"

  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: POST https://api.cloudflare.com/client/v4/accounts/<account>/cfd_tunnel (create named tunnel '${slug}')"
    info "DRY: PUT  https://api.cloudflare.com/client/v4/accounts/<account>/cfd_tunnel/<id>/configurations (ingress -> https://localhost:${APP_PORT})"
    info "DRY: POST https://api.cloudflare.com/client/v4/zones/<zone>/dns_records (CNAME ${hostname} -> <id>.cfargotunnel.com, proxied)"
    info "DRY: write run-token under ${cfd_dir} and load com.robotdojo.cloudflared"
    ok "Cloudflare relay tunnel ready"
    return 0
  fi

  if ! check_command curl; then
    die "curl is required to provision the Cloudflare relay tunnel" "Install curl and re-run."
  fi
  if ! check_command node; then
    die "node is required to provision the Cloudflare relay tunnel" "Install Node.js and re-run."
  fi

  mkdir -p "$cfd_dir"
  chmod 700 "$cfd_dir"

  local api="https://api.cloudflare.com/client/v4"
  local auth_hdr="Authorization: Bearer ${cf_token}"
  local response status body tunnel_id tunnel_token

  # 1) Create the named tunnel. The response carries the tunnel id and the run
  #    token cloudflared needs; a non-200 is a hard, explained failure.
  local create_payload
  create_payload="$(CF_SLUG="$slug" node -e 'process.stdout.write(JSON.stringify({ name: process.env.CF_SLUG, config_src: "cloudflare" }))')"
  response="$(curl --connect-timeout 5 -sS -w '\n%{http_code}' \
    -H "$auth_hdr" -H 'content-type: application/json' \
    -d "$create_payload" \
    "${api}/accounts/${cf_account}/cfd_tunnel" 2>/dev/null || printf '\n000')"
  status="$(printf '%s' "$response" | tail -n 1)"
  body="$(printf '%s' "$response" | sed '$d')"
  if [[ "$status" != "200" ]]; then
    die "Cloudflare tunnel creation failed (HTTP ${status})" \
        "Verify CLOUDFLARE_API_TOKEN has Cloudflare Tunnel:Edit and DNS:Edit, then re-run."
  fi
  tunnel_id="$(CF_BODY="$body" node -e 'const r = JSON.parse(process.env.CF_BODY || "{}"); process.stdout.write((r.result && r.result.id) || "")')"
  tunnel_token="$(CF_BODY="$body" node -e 'const r = JSON.parse(process.env.CF_BODY || "{}"); process.stdout.write((r.result && r.result.token) || "")')"
  if [[ -z "$tunnel_id" || -z "$tunnel_token" ]]; then
    die "Cloudflare tunnel creation returned no id/token" "Re-run the installer; contact support if this persists."
  fi

  # 2) Point the tunnel ingress at the local dojo over loopback TLS. The origin
  #    cert is the device/localhost cert, so noTLSVerify keeps cloudflared from
  #    rejecting it; the hop is localhost-only and never leaves the machine.
  local config_payload
  config_payload="$(CF_HOST="$hostname" CF_PORT="$APP_PORT" node -e 'process.stdout.write(JSON.stringify({ config: { ingress: [ { hostname: process.env.CF_HOST, service: "https://localhost:" + process.env.CF_PORT, originRequest: { noTLSVerify: true } }, { service: "http_status:404" } ] } }))')"
  response="$(curl --connect-timeout 5 -sS -w '\n%{http_code}' -X PUT \
    -H "$auth_hdr" -H 'content-type: application/json' \
    -d "$config_payload" \
    "${api}/accounts/${cf_account}/cfd_tunnel/${tunnel_id}/configurations" 2>/dev/null || printf '\n000')"
  status="$(printf '%s' "$response" | tail -n 1)"
  if [[ "$status" != "200" ]]; then
    die "Cloudflare tunnel ingress configuration failed (HTTP ${status})" \
        "Re-run the installer after confirming the robotdojo.ai zone is delegated."
  fi

  # 3) Create the DNS CNAME so {slug}.robotdojo.ai resolves to the
  #    tunnel. Proxied so Cloudflare terminates TLS with its Universal cert. An
  #    "already exists" (81053/81057) is benign on a re-install — the CNAME
  #    target is stable for this tunnel id.
  local dns_payload
  dns_payload="$(CF_HOST="$hostname" CF_ID="$tunnel_id" node -e 'process.stdout.write(JSON.stringify({ type: "CNAME", name: process.env.CF_HOST, content: process.env.CF_ID + ".cfargotunnel.com", proxied: true }))')"
  response="$(curl --connect-timeout 5 -sS -w '\n%{http_code}' \
    -H "$auth_hdr" -H 'content-type: application/json' \
    -d "$dns_payload" \
    "${api}/zones/${cf_zone}/dns_records" 2>/dev/null || printf '\n000')"
  status="$(printf '%s' "$response" | tail -n 1)"
  if [[ "$status" != "200" ]]; then
    body="$(printf '%s' "$response" | sed '$d')"
    if ! CF_BODY="$body" node -e 'const r = JSON.parse(process.env.CF_BODY || "{}"); const codes = (r.errors || []).map(e => e.code); process.exit(codes.includes(81053) || codes.includes(81057) ? 0 : 1)' 2>/dev/null; then
      die "Cloudflare DNS record creation failed (HTTP ${status})" \
          "Verify the API token has DNS:Edit on the robotdojo.ai zone and re-run."
    fi
    warn "DNS record for ${hostname} already exists — reusing it"
  fi

  # 4) Persist the run token (0600) so the cloudflared LaunchAgent can start the
  #    tunnel headlessly. The hostname is recorded for support/debugging.
  ( umask 077; printf '%s' "$tunnel_token" > "$cfd_dir/token" )
  chmod 600 "$cfd_dir/token"
  printf '%s\n' "$hostname" > "$cfd_dir/hostname"
  chmod 600 "$cfd_dir/hostname"
  ok "Cloudflare tunnel provisioned for ${hostname}"

  # 5) Load the cloudflared LaunchAgent. The plist + manifest entry ship with
  #    the relay LaunchAgent increment (Phase B); install_service loads every
  #    manifest agent immediately after this step, so writing the token first is
  #    what lets the agent start with credentials. If the plist is already on
  #    disk we load it best-effort; its absence is not fatal because
  #    install_service will load it from the manifest.
  if [[ "$OS" == "macos" ]] && check_command launchctl; then
    local cfd_plist="$HOME/Library/LaunchAgents/com.robotdojo.cloudflared.plist"
    if [[ -f "$cfd_plist" ]]; then
      launchctl load -w "$cfd_plist" 2>/dev/null || true
    else
      info "cloudflared LaunchAgent will start after service install"
    fi
  fi
}

# --- Background relay warmup --------------------------------------------
#
# With the dojo address chosen up front, provision the Cloudflare tunnel + DNS
# and warm Cloudflare's per-hostname edge certificate in a detached background
# job so the ~90s warmup overlaps the heavy install steps (clone, npm ci,
# embedding-model download, migrations) instead of blocking the user at the end.

# warm_relay_edge_cert <slug> — repeatedly hit https://{slug}.robotdojo.ai/ to
# drive Cloudflare's per-hostname edge-cert provisioning. We only need each TLS
# handshake to reach Cloudflare's edge; the local origin may still be booting, so
# every curl result (5xx, connection refused, etc.) is intentionally ignored.
warm_relay_edge_cert() {
  local slug="$1"
  [[ -z "$slug" ]] && return 0
  local host="https://${slug}.robotdojo.ai/"
  local i
  for i in $(seq 1 18); do
    curl -sk -o /dev/null --connect-timeout 5 --max-time 10 "$host" >/dev/null 2>&1 || true
    sleep 5
  done
}

# start_relay_warmup_bg — kick off provision_cloudflare_tunnel + warm_relay_edge_cert
# in a detached, non-blocking, non-fatal background job. Guards: only when a dojo
# address was chosen (DOJO_SLUG_CHOSEN), Cloudflare creds are present, and
# node + curl exist. Missing creds => skip gracefully (local-only install; the
# foreground provision path keeps the installer's existing behavior). Sets
# RELAY_PROVISION_BG_STARTED so main() awaits the run-token rather than
# provisioning a second tunnel.
start_relay_warmup_bg() {
  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: start_relay_warmup_bg skipped"
    return 0
  fi

  # No chosen address yet => nothing to warm early; the foreground
  # provision_cloudflare_tunnel handles the device-name default later.
  if [[ "${DOJO_SLUG_CHOSEN:-0}" != "1" ]]; then
    return 0
  fi

  local cf_token cf_account cf_zone slug log_file
  cf_token="${CLOUDFLARE_API_TOKEN:-$(read_keychain_secret CLOUDFLARE_API_TOKEN 2>/dev/null || true)}"
  cf_account="${CLOUDFLARE_ACCOUNT_ID:-$(read_keychain_secret CLOUDFLARE_ACCOUNT_ID 2>/dev/null || true)}"
  cf_zone="${CLOUDFLARE_ZONE_ID:-$(read_keychain_secret CLOUDFLARE_ZONE_ID 2>/dev/null || true)}"
  if [[ -z "$cf_token" || -z "$cf_account" || -z "$cf_zone" ]]; then
    info "Remote access credentials not present — skipping background relay warmup (local-only install)."
    return 0
  fi
  if ! check_command curl || ! check_command node; then
    return 0
  fi

  slug="$(resolve_relay_slug || true)"
  if [[ -z "$slug" ]]; then
    return 0
  fi

  step "Warm remote access in the background"
  info "Setting up https://${slug}.robotdojo.ai and warming its certificate while the rest installs."
  mkdir -p "$ROBOTDOJO_CONFIG/logs" 2>/dev/null || true
  log_file="$ROBOTDOJO_CONFIG/logs/relay-warmup.log"

  # Detached subshell: `{ ...; } &` runs in a subshell that INHERITS these shell
  # functions (so we reuse provision_cloudflare_tunnel), redirects all output to
  # a log so background chatter never corrupts the foreground installer UI, and
  # is disowned so it survives even if the parent shell finishes first. A failure
  # inside the subshell (set -e exits it, or `&&` short-circuits) never
  # propagates to the parent because backgrounded commands do not trip set -e.
  { provision_cloudflare_tunnel && warm_relay_edge_cert "$slug"; } >>"$log_file" 2>&1 &
  disown 2>/dev/null || true

  RELAY_PROVISION_BG_STARTED=1
  ok "Remote access is provisioning in the background (log: $log_file)"
}

# await_relay_tunnel_token — bounded, non-fatal wait for the background job to
# write the cloudflared run-token before install_service loads the tunnel agent.
# By this point the heavy steps have run for minutes, so the token is normally
# already present; the cloudflared LaunchAgent (KeepAlive + 10s throttle) also
# self-heals once the token lands, so a timeout here never aborts the install.
await_relay_tunnel_token() {
  step "Finish remote access setup"

  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: await background relay tunnel token"
    return 0
  fi

  local token_file="$ROBOTDOJO_CONFIG/cloudflared/token"
  local waited=0
  while (( waited < 30 )); do
    if [[ -s "$token_file" ]]; then
      ok "Remote access tunnel ready (provisioned in the background)"
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  warn "Remote access is still provisioning in the background; it will come online shortly."
  return 0
}

# --- Run migrations -----------------------------------------------------

run_migrations() {
  step "6/8  Run migrations"

  # Dry-run skips actual migrations — the DB it would touch is in a tempdir
  # but we still want the install enumeration to be fast and not depend on
  # better-sqlite3 native build readiness.
  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: npm run migrate"
    return 0
  fi

  cd "$ROBOTDOJO_HOME"
  # Ensure migrate script exists — older repos may not have it
  if ! node -e 'const p=require("./package.json"); process.exit(p.scripts && p.scripts.migrate ? 0 : 1)' 2>/dev/null; then
    warn "No migrate script in package.json — creating minimal migrate"
    # Safe to import lib/db.js which runs migrations at import time
    cat > scripts/migrate.js <<'MIGRATE'
#!/usr/bin/env node
// Migrations run on import of lib/db.js (see lib/db.js migrate() calls).
import '../lib/db.js';
console.info('[migrate] done');
MIGRATE
  fi

  # shellcheck disable=SC2016
  ROBOTDOJO_DB="$ROBOTDOJO_CONFIG/robotdojo.db" npm run --silent migrate \
    2>&1 | sed 's/^/    /' || die "Migrations failed" "Check $ROBOTDOJO_CONFIG/logs/ for details."
  ok "Database ready at $ROBOTDOJO_CONFIG/robotdojo.db"

  # One-way compatibility recovery for installs that collected Health chart
  # substrate in the old repo-local DB path before the live encrypted DB became
  # authoritative. Idempotent: exits cleanly when no legacy data exists or the
  # live DB already has chart points.
  if [[ -f "$ROBOTDOJO_HOME/scripts/repair-health-legacy-db.js" ]]; then
    ROBOTDOJO_DB="$ROBOTDOJO_CONFIG/robotdojo.db" \
    ROBOTDOJO_HEALTH_LEGACY_DB="$ROBOTDOJO_HOME/user/databases/robotdojo.db" \
      node "$ROBOTDOJO_HOME/scripts/repair-health-legacy-db.js" \
      2>&1 | sed 's/^/    /' || warn "Health legacy DB repair skipped"
  fi

  # Drop folder — user-facing ingest tree (~/Robot Dojo/{Inbox,…}).
  local drop_init="$ROBOTDOJO_HOME/scripts/init-drop-folder.sh"
  if [[ -x "$drop_init" ]]; then
    "$drop_init" >/dev/null
    ok "Drop folder ready at ${ROBOTDOJO_DROP_ROOT:-$HOME/robotdojo/imports}"
  fi
}

# --- Install service ----------------------------------------------------

# Provision a browser-trusted localhost TLS cert via mkcert.
#
# WHY mkcert: the device cert provisioned by lib/gateway-tls.js#provisionCert
# is bound to {slug}.robotdojo.ai and is NOT trusted for `localhost` SNI.
# Without a localhost-trusted cert the browser refuses to load
# https://localhost:4338 unless the user clicks through a cert warning.
# mkcert generates a local cert covering localhost+127.0.0.1+::1 and installs
# its CA into the system keychain so every browser on the machine trusts it.
# install.sh provisions the cert BEFORE install_launch_agents() so the
# server reads it on first boot (failure manifest #5).
#
# Failure path: if `brew` is missing or mkcert install fails, log a clear
# warning and continue. The server falls back to the device cert which is
# still functional for tunnel traffic — only localhost trust degrades to
# self-signed (cert warning). Stage 2 captures the real-world failure mode.
provision_mkcert_local_tls() {
  step "7/8  Provision local TLS cert (mkcert)"

  if [[ "$OS" != "macos" ]]; then
    info "mkcert: macOS-only — skipping local TLS provisioning on ${OS}"
    return 0
  fi

  if ! check_command mkcert; then
    info "Installing mkcert via Homebrew (local TLS CA + cert provisioner)..."
    if ! check_command brew; then
      warn "Homebrew not available — skipping mkcert install. Local browser will warn on https://localhost:${APP_PORT}"
      return 0
    fi
    run_or_dry "brew install mkcert nss" brew install mkcert nss || {
      warn "mkcert install failed — local browser will warn on https://localhost:${APP_PORT}"
      return 0
    }
  fi

  # mkcert -install seeds the local CA into the system keychain (system
  # keychain prompt is interactive; for re-runs and dry-run we no-op).
  run_or_dry "mkcert -install" mkcert -install || {
    warn "mkcert -install failed (CA seeding) — cert generation may still work but won't be trusted"
  }

  if [[ "$ROBOTDOJO_DRY_RUN" != "1" ]]; then
    mkdir -p "$LOCALHOST_TLS_DIR"
    chmod 700 "$LOCALHOST_TLS_DIR"
  fi

  # Generate cert + key into ~/.robotdojo/tls/localhost.{crt,key}.
  # SANs cover the three addresses the server binds locally: localhost,
  # 127.0.0.1, and ::1 — index.js' SNI handler routes any of them to this
  # cert.
  run_or_dry "mkcert -cert-file ${LOCALHOST_CERT_PATH} -key-file ${LOCALHOST_KEY_PATH} localhost 127.0.0.1 ::1" \
    mkcert -cert-file "$LOCALHOST_CERT_PATH" -key-file "$LOCALHOST_KEY_PATH" \
      localhost 127.0.0.1 ::1 || {
    warn "mkcert cert generation failed — local browser will warn on https://localhost:${APP_PORT}"
    return 0
  }

  if [[ "$ROBOTDOJO_DRY_RUN" != "1" ]]; then
    if [[ -f "$LOCALHOST_CERT_PATH" ]] && [[ -f "$LOCALHOST_KEY_PATH" ]]; then
      chmod 600 "$LOCALHOST_KEY_PATH"
      ok "mkcert local TLS cert provisioned at $LOCALHOST_CERT_PATH"
    else
      warn "mkcert reported success but cert files are missing — fallback to device cert on boot"
    fi
  fi
}

install_macos_permission_app() {
  if [[ "$OS" != "macos" ]]; then
    return 0
  fi
  local node_bin="$1"
  local path_value="$2"
  local helper_script="$ROBOTDOJO_HOME/scripts/install-macos-permission-helper.sh"
  if [[ ! -f "$helper_script" ]]; then
    warn "macOS runtime app installer missing — local permissions will fall back to node"
    return 1
  fi

  local output
  if output="$(
    ROBOTDOJO_HOME="$ROBOTDOJO_HOME" \
    ROBOTDOJO_CONFIG="$ROBOTDOJO_CONFIG" \
    ROBOTDOJO_NODE_BIN="$node_bin" \
    ROBOTDOJO_PATH_VALUE="$path_value" \
    ROBOTDOJO_PERMISSION_APP="$ROBOTDOJO_PERMISSION_APP" \
    ROBOTDOJO_PERMISSION_LAUNCHER="$ROBOTDOJO_PERMISSION_LAUNCHER" \
    ROBOTDOJO_DRY_RUN="$ROBOTDOJO_DRY_RUN" \
    bash "$helper_script" 2>&1
  )"; then
    if [[ -n "$output" ]]; then
      info "$output"
    fi
    ok "macOS Robot Dojo runtime app ready"
    return 0
  else
    warn "$output"
    warn "Robot Dojo will still run, but macOS Full Disk Access may fall back to node"
    return 1
  fi
}

# install_launch_agents — manifest-driven LaunchAgent install.
#
# The manifest at config/launch-agents.json is the single source of truth for
# every product LaunchAgent. scripts/check-installer-parity.js enforces that
# (a) every manifest entry has a template file, (b) every template has a
# manifest entry, and (c) install.sh contains no `launchctl load <literal>`
# outside this function. The label `com.robotdojo.*` is the parity invariant.
#
# Per-entry steps: read the template, substitute placeholders, write to
# ~/Library/LaunchAgents/<label>.plist, then unload-and-load to apply.
# Every side effect is dry-run-wrapped so VC7 can enumerate the install set
# without touching launchd or the filesystem.
install_launch_agents() {
  if ! check_command node; then
    die "node not in PATH" "Re-run preflight to install Node.js."
  fi

  if [[ ! -f "$LAUNCH_AGENTS_MANIFEST" ]]; then
    die "LaunchAgent manifest not found: $LAUNCH_AGENTS_MANIFEST" \
        "Re-run install.sh after pulling latest, or restore config/launch-agents.json from the repo."
  fi

  local node_bin path_value runtime_bin app_runtime_bin
  node_bin="$(command -v node)"
  path_value="$PATH"
  runtime_bin="$node_bin"
  app_runtime_bin="$ROBOTDOJO_PERMISSION_APP/Contents/MacOS/Robot Dojo"
  if [[ -n "$ROBOTDOJO_RUNTIME_BIN" ]]; then
    runtime_bin="$ROBOTDOJO_RUNTIME_BIN"
  elif install_macos_permission_app "$node_bin" "$path_value"; then
    if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]] || [[ -x "$app_runtime_bin" ]]; then
      runtime_bin="$app_runtime_bin"
    fi
  fi
  local launch_dir="$HOME/Library/LaunchAgents"
  if [[ "$ROBOTDOJO_DRY_RUN" != "1" ]]; then
    mkdir -p "$launch_dir"
  fi

  # Drive the loop with node — JSON parsing in pure bash is fragile and
  # `jq` is not guaranteed on a fresh Mac. Node is already a hard requirement
  # so depending on it here adds no install surface.
  local entries
  entries="$(node -e "
    const fs = require('node:fs');
    const m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    for (const a of m.agents || []) {
      if (a && a.label && a.template) {
        process.stdout.write(a.label + '\t' + a.template + '\n');
      }
    }
  " "$LAUNCH_AGENTS_MANIFEST")"

  if [[ -z "$entries" ]]; then
    die "LaunchAgent manifest has zero agents — refusing to install" \
        "Inspect $LAUNCH_AGENTS_MANIFEST."
  fi

  local label template template_abs plist_dest
  while IFS=$'\t' read -r label template; do
    [[ -z "$label" ]] && continue
    template_abs="$ROBOTDOJO_HOME/$template"
    if [[ ! -f "$template_abs" ]]; then
      warn "Missing template for ${label}: ${template_abs} — skipping"
      continue
    fi
    plist_dest="$launch_dir/${label}.plist"

    if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
      printf 'DRY: write %s\n' "$plist_dest"
      printf 'DRY: launchctl unload %s\n' "$plist_dest"
      printf 'DRY: launchctl load %s\n' "$plist_dest"
      ok "LaunchAgent ${label}: dry-run (would install from ${template})"
      continue
    fi

    # Substitute installer placeholders. All templates share this set; an
    # extra one in the future just becomes an extra `-e` here.
    sed \
      -e "s|__HOME__|${HOME}|g" \
      -e "s|__USER__|${USER:-robotdojo}|g" \
      -e "s|__CONFIG__|${ROBOTDOJO_CONFIG}|g" \
      -e "s|__NODE__|${node_bin}|g" \
      -e "s|__ROBOTDOJO_RUNTIME__|${runtime_bin}|g" \
      -e "s|__PATH__|${path_value}|g" \
      -e "s|__ROBOTDOJO_APP__|${ROBOTDOJO_PERMISSION_APP}|g" \
      -e "s|__ROBOTDOJO_LAUNCHER__|${ROBOTDOJO_PERMISSION_LAUNCHER}|g" \
      -e "s|__ROBOTDOJO_HOME__|${ROBOTDOJO_HOME}|g" \
      "$template_abs" > "$plist_dest"

    # Unload-then-load is the idempotent restart pattern: unload fails
    # silently if the plist isn't loaded, load fails loudly if there's a
    # real problem with the plist.
    launchctl unload "$plist_dest" 2>/dev/null || true
    if ! launchctl load "$plist_dest" 2>/dev/null; then
      warn "launchctl load failed for ${label} — check $plist_dest"
      continue
    fi
    ok "LaunchAgent ${label}: installed"
  done <<< "$entries"
}

install_service_macos() {
  install_launch_agents
}

install_service_linux() {
  local unit_template="$ROBOTDOJO_HOME/apps/static/robotdojo.service.template"
  [[ -f "$unit_template" ]] || die "Missing systemd template: $unit_template" "Re-run the installer."

  mkdir -p "$SYSTEMD_UNIT_DIR"
  local node_bin npm_bin
  node_bin="$(command -v node)"
  npm_bin="$(command -v npm)"

  sed \
    -e "s|__HOME__|${ROBOTDOJO_HOME}|g" \
    -e "s|__CONFIG__|${ROBOTDOJO_CONFIG}|g" \
    -e "s|__NODE__|${node_bin}|g" \
    -e "s|__NPM__|${npm_bin}|g" \
    -e "s|__PATH__|${PATH}|g" \
    "$unit_template" > "$SYSTEMD_UNIT_PATH"

  systemctl --user daemon-reload || die "systemctl daemon-reload failed" "Is systemd --user available?"
  systemctl --user enable "$SYSTEMD_UNIT_NAME" >/dev/null 2>&1 || true
  systemctl --user restart "$SYSTEMD_UNIT_NAME" || die "systemctl restart failed" \
      "Run: systemctl --user status robotdojo"

  # Optional: enable linger so service runs without login
  if check_command loginctl && ! loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
    info "Tip: 'sudo loginctl enable-linger $USER' to run without login"
  fi
  ok "systemd user service installed"
}

install_service() {
  step "8/8  Install background service"

  if [[ "${ROBOTDOJO_NO_SERVICE:-0}" == "1" ]]; then
    info "ROBOTDOJO_NO_SERVICE=1 set — skipping service install"
    info "Start manually: cd $ROBOTDOJO_HOME && npm start"
    return 0
  fi

  if [[ "$OS" == "macos" ]]; then
    install_service_macos
  else
    install_service_linux
  fi
}

# --- Wait for health ----------------------------------------------------

wait_for_health() {
  step "Wait for service to come up"

  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: wait_for_health skipped (no real server in dry-run)"
    return 0
  fi

  # WHY https://localhost:${APP_PORT}/api/server-health?deep=1:
  #   * The server runs HTTPS on 4338 whenever a TLS cert is present, and
  #     provision_mkcert_local_tls() (called above) ensures one is. Polling
  #     `http://` would hit a TLS handshake error and silently fail.
  #   * `/health` is the HTML dashboard (no `ok` string in body); the JSON
  #     status endpoint is `/api/server-health?deep=1` which proves the DB can
  #     be read, integrity-checked, written, and read back before browser handoff.
  #   * No `-k`: mkcert just installed its CA into the system keychain, so
  #     the cert is trusted. If `-k` were needed, mkcert trust failed — the
  #     warning above told the user, and we still want to surface "service
  #     not healthy" rather than silently mask a trust failure.
  local url="https://localhost:${APP_PORT}/api/server-health?deep=1"
  local max_attempts=30
  local attempt=0
  local body

  while (( attempt < max_attempts )); do
    if body="$(curl --connect-timeout 3 -fsS --max-time 5 "$url" 2>/dev/null)" \
      && HEALTH_JSON="$body" node -e 'const h = JSON.parse(process.env.HEALTH_JSON || "{}"); process.exit(h.status === "ok" && h.deep === true && h.db && h.db.ok === true ? 0 : 1);' 2>/dev/null; then
      ok "Service and database healthy at $url"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  warn "Service did not respond at $url within ${max_attempts}s"
  warn "Check logs: tail -f $ROBOTDOJO_CONFIG/logs/*.log"
  return 1
}

# --- Wait for relay -----------------------------------------------------

resolve_relay_slug() {
  if [[ -n "${ROBOTDOJO_DEVICE_SLUG:-}" ]]; then
    printf '%s' "$ROBOTDOJO_DEVICE_SLUG"
    return 0
  fi
  if [[ "$OS" == "macos" ]] && [[ "$ROBOTDOJO_DRY_RUN" != "1" ]]; then
    local keychain_slug
    keychain_slug="$(security find-generic-password -s "${ROBOTDOJO_KEYCHAIN_PREFIX}robotdojo-ROBOTDOJO_DEVICE_SLUG" -w 2>/dev/null || true)"
    if [[ -n "$keychain_slug" ]]; then
      printf '%s' "$keychain_slug"
      return 0
    fi
  fi
  if [[ -f "${ROBOTDOJO_CONFIG}/initial-slug" ]]; then
    tr -d '\n\r' < "${ROBOTDOJO_CONFIG}/initial-slug"
    return 0
  fi
  return 1
}

wait_for_relay_readiness() {
  step "Check optional remote access relay"

  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: wait_for_relay_readiness skipped (no real relay in dry-run)"
    return 0
  fi

  local slug
  slug="$(resolve_relay_slug || true)"
  if [[ -z "$slug" ]]; then
    warn "Remote access relay is not configured yet"
    warn "Local Robot Dojo is ready; set up remote access from Account if you want it."
    return 1
  fi

  # The slug URL is a plumbing-only readiness probe. Remote access is optional:
  # local install success depends on the local server and database only.
  local url="https://${slug}.robotdojo.ai/api/server-health?deep=1"
  local max_attempts=45
  local attempt=0
  local body

  while (( attempt < max_attempts )); do
    if body="$(curl --connect-timeout 3 -fsS --max-time 5 "$url" 2>/dev/null)" \
      && HEALTH_JSON="$body" node -e 'const h = JSON.parse(process.env.HEALTH_JSON || "{}"); process.exit(h.status === "ok" && h.deep === true && h.db && h.db.ok === true ? 0 : 1);' 2>/dev/null; then
      RELAY_READY_URL="$url"
      ok "Remote access relay is ready"
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  warn "Remote access relay did not become ready within ${max_attempts}s"
  warn "Check logs: tail -f $ROBOTDOJO_CONFIG/logs/*.log"
  return 1
}

# --- Open browser -------------------------------------------------------

open_browser() {
  if [[ "${ROBOTDOJO_NO_OPEN:-0}" == "1" ]]; then
    return 0
  fi
  local slug token redirect_arg prompt_arg open_url local_origin
  slug="$(resolve_relay_slug || true)"
  token="$(read_keychain_secret "ROBOTDOJO_AUTH_TOKEN" || true)"
  redirect_arg="$(urlencode "/account/integrations")"
  prompt_arg="$(urlencode "How do I finish setting up Robot Dojo?")"
  local_origin="https://localhost:${APP_PORT}"
  INTEGRATIONS_HANDOFF_URL="${local_origin}/account/integrations"
  CHAT_HANDOFF_URL="${local_origin}/chat?context=setup-guide&prompt=${prompt_arg}"

  # st_96bb626f AC 1: print the access token to the terminal BEFORE opening the
  # browser so the user can connect from this or any other device. Sourced from
  # the Keychain — never a flat file (build-conventions forbids ~/.robotdojo/api-key).
  if [[ -n "$token" ]]; then
    info "────────────────────────────────────────"
    if [[ -n "$slug" ]]; then
      info "Your dojo address:  https://${slug}.robotdojo.ai"
      info "(Private door into THIS Mac — only your machine answers that name.)"
    fi
    info "Login token (keep private):  ${token}"
    info "Reveal later:  npm run token -- show"
    info "Rotate later:  npm run token -- rotate"
    info "Local always works:  https://localhost:${APP_PORT}"
    info "────────────────────────────────────────"
  fi

  # Prefer localhost when the relay is not actually ready. A slug without a
  # live tunnel opens a dead hostname; friends must land on working Chat.
  local relay_ready=0
  if [[ -n "$slug" ]] && curl --connect-timeout 2 -fsS --max-time 3 \
      "https://${slug}.robotdojo.ai/api/server-health" >/dev/null 2>&1; then
    relay_ready=1
  fi
  if [[ "$relay_ready" = "1" && -n "$token" ]]; then
    open_url="https://${slug}.robotdojo.ai/auth/local-start?token=$(urlencode "$token")&redirect=${redirect_arg}"
  elif [[ -n "$token" ]]; then
    open_url="${local_origin}/auth/local-start?token=$(urlencode "$token")&redirect=${redirect_arg}"
  else
    open_url="$INTEGRATIONS_HANDOFF_URL"
  fi

  if [[ "$OS" == "macos" ]]; then
    open "$open_url" 2>/dev/null || true
    ( sleep 2; open "$CHAT_HANDOFF_URL" 2>/dev/null || true ) &
  elif check_command xdg-open; then
    xdg-open "$open_url" >/dev/null 2>&1 || true
    ( sleep 2; xdg-open "$CHAT_HANDOFF_URL" >/dev/null 2>&1 || true ) &
  fi
}

open_local_permissions_setup() {
  if [[ "$OS" != "macos" || "${ROBOTDOJO_NO_OPEN:-0}" == "1" || "${ROBOTDOJO_NO_OPEN_PERMISSIONS:-0}" == "1" ]]; then
    return 0
  fi
  if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
    info "DRY: open macOS Full Disk Access"
    return 0
  fi
  info "Opening Full Disk Access. Turn on Robot Dojo. If this install reports a node fallback path, turn on node instead."
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" 2>/dev/null || true
}

# --- Success banner -----------------------------------------------------

success_banner() {
  local slug_line="" remote_line="" token_line=""
  local slug token remote_ready=0
  slug="$(resolve_relay_slug 2>/dev/null || true)"
  token="$(read_keychain_secret "ROBOTDOJO_AUTH_TOKEN" 2>/dev/null || true)"
  # Only claim remote is live when the SNI relay actually answers — a slug
  # without bootstrap/cert/tunnel-client is local-only (no friend CF zone keys).
  if [[ -n "$slug" ]] && curl --connect-timeout 2 -fsS --max-time 3 \
      "https://${slug}.robotdojo.ai/api/server-health" >/dev/null 2>&1; then
    remote_ready=1
  fi
  if [[ "$remote_ready" = "1" && -n "$slug" ]]; then
    slug_line="  ${C_BOLD}Remote dojo:${C_RESET} https://${slug}.robotdojo.ai  (this Mac — live)"
    remote_line="  ${C_DIM}Remote path: slug → VPS DNS + TLS cert + outbound tunnel from this Mac (no Cloudflare keys on your machine).${C_RESET}"
  elif [[ -n "$slug" ]]; then
    slug_line="  ${C_BOLD}Remote dojo:${C_RESET} https://${slug}.robotdojo.ai  (claimed; finishing tunnel/cert if bootstrap is set)"
    remote_line="  ${C_DIM}Local Chat is ready now. Remote needs ROBOTDOJO_RELAY_BOOTSTRAP_SECRET on install (operator invite) — never Cloudflare zone tokens.${C_RESET}"
  else
    slug_line="  ${C_BOLD}Remote dojo:${C_RESET} not configured — local URL below always works"
    remote_line="  ${C_DIM}Remote is optional Black Belt. Re-run with ROBOTDOJO_RELAY_BOOTSTRAP_SECRET + DOJO_SLUG when invited.${C_RESET}"
  fi
  if [[ -n "$token" ]]; then
    token_line="  ${C_BOLD}Login token:${C_RESET} ${token}"
  else
    token_line="  ${C_BOLD}Token:${C_RESET}      npm run token -- show   (in $ROBOTDOJO_HOME)"
  fi
  cat <<EOF

${C_GREEN}${C_BOLD}  Robot Dojo is running.${C_RESET}

  ${C_BOLD}Integrations:${C_RESET} ${INTEGRATIONS_HANDOFF_URL:-https://localhost:${APP_PORT}/account/integrations}
  ${C_BOLD}Chat help:${C_RESET}    ${CHAT_HANDOFF_URL:-https://localhost:${APP_PORT}/chat?context=setup-guide}
${slug_line}
${remote_line}
  ${C_BOLD}Local:${C_RESET}      https://localhost:${APP_PORT}
${token_line}
  ${C_BOLD}Reveal later:${C_RESET} npm run token -- show   (in $ROBOTDOJO_HOME)
  ${C_BOLD}Home:${C_RESET}       $ROBOTDOJO_HOME
  ${C_BOLD}Config:${C_RESET}     $ROBOTDOJO_CONFIG
  ${C_BOLD}Logs:${C_RESET}       $ROBOTDOJO_CONFIG/logs/
  ${C_BOLD}This Mac:${C_RESET}   ${DEVICE_NAME:-unknown}
  ${C_BOLD}Black Belt:${C_RESET}  90-day trial on at install (entity-aware chat + enrich)

  ${C_DIM}Next: connect accounts in Integrations, then ask Chat something only your data can answer.${C_RESET}
  ${C_DIM}Uninstall:  curl -fsSL https://robotdojo.ai/uninstall.sh | bash${C_RESET}

EOF
}

# --- Main ---------------------------------------------------------------

main() {
  logo
  # Homebrew is a prerequisite for everything else on macOS — install before
  # preflight so node-via-nvm has a working /opt/homebrew or /usr/local PATH.
  ensure_homebrew_macos
  preflight
  # Ask for the dojo address FIRST (before the heavy steps), then kick off the
  # Cloudflare tunnel + edge-cert warmup in the background so the ~90s warmup
  # overlaps clone / npm ci / embedding-model download / migrations. Both are
  # no-ops in dry-run and when no address was chosen / no creds are present.
  prompt_dojo_slug
  start_relay_warmup_bg
  clone_repo
  install_deps
  setup_device_name
  bootstrap_config
  # Capture the owner's declared identity before the server's first ingest so
  # the owner-anchor guard is armed on first run (df_cbd30a5a).
  prompt_owner_identity
  ensure_local_embedding_model
  ensure_relay_identity
  run_migrations
  # mkcert MUST run BEFORE install_service: install_launch_agents() will load
  # com.robotdojo.server which boots index.js, and index.js calls
  # getLocalhostCertPaths() at startup. If the cert isn't on disk yet, the
  # server falls back to the device cert and the localhost browser experience
  # degrades to a self-signed warning (failure manifest #5).
  provision_mkcert_local_tls
  provision_device_tls
  # Provision the per-user Cloudflare relay tunnel + DNS and write its run-token
  # BEFORE install_service loads the cloudflared LaunchAgent (st_96bb626f AC 1).
  # When the address was chosen up front, start_relay_warmup_bg already kicked
  # this off in the background — here we only wait for its run-token to land so
  # we never provision a second tunnel. Otherwise (device-name default path) we
  # provision it now.
  if [[ "${RELAY_PROVISION_BG_STARTED:-0}" = "1" ]]; then
    await_relay_tunnel_token
  else
    provision_cloudflare_tunnel
  fi
  install_service
  # Build layer (skills/personas) for coding agents — after product code is
  # present. Soft-fail so a friend still reaches Chat if Claude/Codex paths fail.
  install_agent_os
  # Ollama install + RAM-based model pull. After this returns the user can
  # chat with the local model even before adding an API key. Cloud keys do not
  # remove Ollama; local fallback remains available after setup.
  ensure_ollama_macos
  wait_for_health
  if ! wait_for_relay_readiness; then
    warn "Continuing with local access. Remote access can be repaired later in Account."
  fi
  open_local_permissions_setup
  open_browser
  success_banner
}

# Source-only mode (df_cbd30a5a tests): define functions without running main so
# a test can `source install.sh` and drive a single step (e.g. prompt_owner_identity).
if [[ "${ROBOTDOJO_INSTALL_SOURCE_ONLY:-0}" != "1" ]]; then
  main "$@"
fi
