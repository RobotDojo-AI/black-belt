#!/usr/bin/env bash
# Create the named macOS app bundle and launcher used in local-data setup.
#
# The production LaunchAgent runs the app-bundled executable at
# ~/Applications/Robot Dojo.app/Contents/MacOS/Robot Dojo. That executable is
# a copied Node runtime with the Robot Dojo bundle identity, so macOS privacy
# prompts and Full Disk Access can show Robot Dojo instead of the Homebrew
# `node` binary. Public distribution should use a Developer ID signature;
# local installs use an ad-hoc signature when no identity is configured.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

ROBOTDOJO_HOME="${ROBOTDOJO_HOME:-$HOME/robotdojo}"
ROBOTDOJO_CONFIG="${ROBOTDOJO_CONFIG:-$HOME/.robotdojo}"
ROBOTDOJO_NODE_BIN="${ROBOTDOJO_NODE_BIN:-$(command -v node)}"
ROBOTDOJO_PATH_VALUE="${ROBOTDOJO_PATH_VALUE:-$PATH}"
ROBOTDOJO_PERMISSION_APP="${ROBOTDOJO_PERMISSION_APP:-$HOME/Applications/Robot Dojo.app}"
ROBOTDOJO_PERMISSION_LAUNCHER="${ROBOTDOJO_PERMISSION_LAUNCHER:-$ROBOTDOJO_CONFIG/bin/Robot Dojo}"
ROBOTDOJO_CODESIGN_IDENTITY="${ROBOTDOJO_CODESIGN_IDENTITY:--}"
ROBOTDOJO_DRY_RUN="${ROBOTDOJO_DRY_RUN:-0}"

if [[ -z "$ROBOTDOJO_NODE_BIN" ]]; then
  echo "Robot Dojo permission helper requires Node.js in PATH" >&2
  exit 1
fi

if [[ "$ROBOTDOJO_DRY_RUN" = "1" ]]; then
  printf 'DRY: install Robot Dojo macOS runtime app at %s\n' "$ROBOTDOJO_PERMISSION_APP"
  printf 'DRY: install Robot Dojo macOS launcher at %s\n' "$ROBOTDOJO_PERMISSION_LAUNCHER"
  exit 0
fi

quote_shell() {
  printf '%q' "$1"
}

bundle_dir="$ROBOTDOJO_PERMISSION_APP"
contents_dir="$bundle_dir/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"
frameworks_dir="$contents_dir/Frameworks"
executable="$macos_dir/Robot Dojo"
info_plist="$contents_dir/Info.plist"
launcher_dir="$(dirname "$ROBOTDOJO_PERMISSION_LAUNCHER")"

resolve_symlink() {
  local target="$1"
  local dir link
  while [[ -L "$target" ]]; do
    dir="$(cd -P "$(dirname "$target")" && pwd)"
    link="$(readlink "$target")"
    if [[ "$link" = /* ]]; then
      target="$link"
    else
      target="$dir/$link"
    fi
  done
  dir="$(cd -P "$(dirname "$target")" && pwd)"
  printf '%s/%s\n' "$dir" "$(basename "$target")"
}

resolve_dylib_dep() {
  local dep="$1"
  local loader_dir="$2"
  local dep_name candidate

  case "$dep" in
    /usr/lib/*|/System/Library/*)
      return 1
      ;;
    @rpath/*)
      dep_name="${dep#@rpath/}"
      for candidate in \
        "$loader_dir/$dep_name" \
        "$loader_dir/../lib/$dep_name" \
        "$(dirname "$node_real")/../lib/$dep_name" \
        "/opt/homebrew/lib/$dep_name" \
        "/usr/local/lib/$dep_name" \
        "/opt/homebrew/opt/node/lib/$dep_name" \
        "/usr/local/opt/node/lib/$dep_name"; do
        if [[ -f "$candidate" ]]; then
          resolve_symlink "$candidate"
          return 0
        fi
      done
      return 1
      ;;
    @loader_path/*)
      candidate="$loader_dir/${dep#@loader_path/}"
      [[ -f "$candidate" ]] || return 1
      resolve_symlink "$candidate"
      return 0
      ;;
    @executable_path/*)
      candidate="$macos_dir/${dep#@executable_path/}"
      [[ -f "$candidate" ]] || return 1
      resolve_symlink "$candidate"
      return 0
      ;;
    /*)
      [[ -f "$dep" ]] || return 1
      resolve_symlink "$dep"
      return 0
      ;;
  esac
  return 1
}

bundled_dylibs=''

already_bundled_dylib() {
  printf '%s\n' "$bundled_dylibs" | grep -Fxq "$1"
}

mark_bundled_dylib() {
  bundled_dylibs="${bundled_dylibs}${1}"$'\n'
}

bundle_dylib_dependencies() {
  local binary="$1"
  local dependency_source="${2:-$binary}"
  local dependency_source_real loader_dir dep dep_abs dep_base dep_dest dep_dest_real install_name
  dependency_source_real="$(resolve_symlink "$dependency_source")"
  loader_dir="$(dirname "$dependency_source_real")"

  while IFS= read -r dep; do
    [[ -z "$dep" ]] && continue
    if ! dep_abs="$(resolve_dylib_dep "$dep" "$loader_dir")"; then
      continue
    fi
    if [[ "$dep_abs" = "$dependency_source_real" ]]; then
      continue
    fi
    dep_base="$(basename "$dep_abs")"
    dep_dest="$frameworks_dir/$dep_base"
    dep_dest_real="$(resolve_symlink "$dep_dest" 2>/dev/null || true)"
    install_name="@executable_path/../Frameworks/$dep_base"

    if ! already_bundled_dylib "$dep_abs"; then
      if [[ -n "$dep_dest_real" ]] && [[ "$dep_abs" = "$dep_dest_real" ]]; then
        mark_bundled_dylib "$dep_abs"
        continue
      fi
      cp "$dep_abs" "$dep_dest"
      chmod 755 "$dep_dest"
      mark_bundled_dylib "$dep_abs"
      mark_bundled_dylib "$(resolve_symlink "$dep_dest")"
      if command -v install_name_tool >/dev/null 2>&1; then
        install_name_tool -id "$install_name" "$dep_dest" 2>/dev/null || true
      fi
      bundle_dylib_dependencies "$dep_dest" "$dep_abs"
    fi

    if command -v install_name_tool >/dev/null 2>&1; then
      install_name_tool -change "$dep" "$install_name" "$binary" 2>/dev/null || true
    fi
  done < <(otool -L "$dependency_source_real" 2>/dev/null | awk 'NR > 1 { print $1 }')
}

# The helper app is installer-owned. Clear stale generated contents first so
# older launcher binaries cannot survive inside the bundle and break signing.
rm -rf "$macos_dir" "$resources_dir" "$frameworks_dir"
mkdir -p "$macos_dir" "$resources_dir" "$frameworks_dir" "$launcher_dir"
if [[ -L "$ROBOTDOJO_PERMISSION_LAUNCHER" ]]; then
  rm -f "$ROBOTDOJO_PERMISSION_LAUNCHER"
fi

launcher_home_q="$(quote_shell "$HOME")"
launcher_user_q="$(quote_shell "${USER:-robotdojo}")"
launcher_path_q="$(quote_shell "$ROBOTDOJO_PATH_VALUE")"
launcher_dojo_home_q="$(quote_shell "$ROBOTDOJO_HOME")"
launcher_config_q="$(quote_shell "$ROBOTDOJO_CONFIG")"
launcher_db_q="$(quote_shell "$ROBOTDOJO_CONFIG/robotdojo.db")"
launcher_permission_app_q="$(quote_shell "$ROBOTDOJO_PERMISSION_APP")"
launcher_runtime_q="$(quote_shell "$executable")"

cat > "$ROBOTDOJO_PERMISSION_LAUNCHER" <<EOF
#!/usr/bin/env bash
set -euo pipefail

export HOME=$launcher_home_q
export USER=$launcher_user_q
export PATH=$launcher_path_q
export NODE_ENV=production
export ROBOTDOJO_HOME=$launcher_dojo_home_q
export ROBOTDOJO_CONFIG=$launcher_config_q
export ROBOTDOJO_DB=$launcher_db_q
export ROBOTDOJO_PERMISSION_APP=$launcher_permission_app_q

cd "\$ROBOTDOJO_HOME"
exec $launcher_runtime_q "\$ROBOTDOJO_HOME/index.js"
EOF
chmod 755 "$ROBOTDOJO_PERMISSION_LAUNCHER"

cat > "$info_plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>Robot Dojo</string>
  <key>CFBundleIdentifier</key>
  <string>com.robotdojo.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Robot Dojo</string>
  <key>CFBundleDisplayName</key>
  <string>Robot Dojo</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>Robot Dojo uses local Mac permissions only when you connect local integrations.</string>
</dict>
</plist>
PLIST

node_real="$(resolve_symlink "$ROBOTDOJO_NODE_BIN")"
cp "$node_real" "$executable"
chmod 755 "$executable"

if command -v otool >/dev/null 2>&1; then
  bundle_dylib_dependencies "$executable"
fi

if command -v codesign >/dev/null 2>&1; then
  while IFS= read -r -d '' dylib; do
    codesign --force --sign "$ROBOTDOJO_CODESIGN_IDENTITY" "$dylib" >/dev/null
  done < <(find "$frameworks_dir" -type f -name '*.dylib' -print0)
  codesign --force --sign "$ROBOTDOJO_CODESIGN_IDENTITY" "$executable" >/dev/null
  codesign --force --deep --sign "$ROBOTDOJO_CODESIGN_IDENTITY" "$bundle_dir" >/dev/null
fi

"$executable" --version >/dev/null

printf '%s\n' "$ROBOTDOJO_PERMISSION_APP"
printf '%s\n' "$ROBOTDOJO_PERMISSION_LAUNCHER"
printf '%s\n' "$executable"
