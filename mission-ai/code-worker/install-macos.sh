#!/bin/bash
set -euo pipefail

PIN="67d75d859aee891923c40cde1db073489d74a424"
WORKER_ID="mac-primary-code"
CODE_API_URL="${MISSION_AI_CODE_API_URL:-https://mission-ai-code-api-mckee.onrender.com/v1}"
BASE_DIR="$HOME/.local/share/mission-ai/code-worker"
RELEASE_DIR="$BASE_DIR/releases/$PIN"
CURRENT_LINK="$BASE_DIR/current"
IDENTITY_DIR="$HOME/.config/librechat/code"
IDENTITY_FILE="$IDENTITY_DIR/$WORKER_ID.json"
PLIST="$HOME/Library/LaunchAgents/com.missionai.code-worker.plist"
WATCHDOG_PLIST="$HOME/Library/LaunchAgents/com.missionai.code-worker-approval-watchdog.plist"
LOG_DIR="$HOME/Library/Logs/MissionAI"
DOC_BIN="$HOME/.local/share/mission-ai/document-tools/venv/bin"
CLI="$RELEASE_DIR/packages/code/dist/cli.js"
APPROVAL_PATCH="$(cd "$(dirname "$0")" && pwd)/apply-approval-patch.mjs"
INTERACTIVE_HELPER="$(cd "$(dirname "$0")" && pwd)/interactive-macos.py"
PAIR_SERVICE="mission-ai-code-pairing-code"
WORKSPACE_DIR="${MISSION_AI_CODE_WORKSPACE_DIR:-}"

# An existing checkout can live inside the worker's default storage directory.
# Register that checkout itself, so chat's workspace/ namespace maps to its root.
WORKSPACE_ARGUMENTS='    <string>--default-workspace</string>'
if [[ -n "$WORKSPACE_DIR" ]]; then
  [[ "$WORKSPACE_DIR" == /* && -d "$WORKSPACE_DIR" ]] || {
    echo 'MISSION_AI_CODE_WORKSPACE_DIR must be an existing absolute directory' >&2
    exit 1
  }
  WORKSPACE_DIR="$(realpath "$WORKSPACE_DIR")"
  case "$WORKSPACE_DIR" in
    "$HOME/.local/share/librechat/code/workspaces/"*|"$HOME/Documents/Codex/"*) ;;
    *) echo 'Code workspace must be inside LibreChat worker storage or Documents/Codex' >&2; exit 1 ;;
  esac
  [[ "$WORKSPACE_DIR" != *[\<\>\&\"\']* && "$WORKSPACE_DIR" != *$'\n'* ]] || {
    echo 'Code workspace path contains unsupported XML characters' >&2
    exit 1
  }
  WORKSPACE_ARGUMENTS="    <string>--worker-dir</string>
    <string>$WORKSPACE_DIR</string>"
fi

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1"
    exit 1
  }
}

if ! command -v node >/dev/null 2>&1; then
  if [[ -x /opt/homebrew/bin/node ]]; then
    export PATH="/opt/homebrew/bin:$PATH"
  elif [[ -x /usr/local/bin/node ]]; then
    export PATH="/usr/local/bin:$PATH"
  fi
fi

need node
need git
need security
need screen
need python3

NODE_VERSION="$(node -p "process.versions.node.split('.').map(Number)")"
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if (( NODE_MAJOR < 20 )); then
  echo "Node.js 20.11+ is required. Current: $(node --version)"
  exit 1
fi

if ! command -v rg >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install ripgrep
  else
    echo "ripgrep is required. Install Homebrew/ripgrep, then rerun."
    exit 1
  fi
fi

mkdir -p "$BASE_DIR/releases" "$IDENTITY_DIR" "$HOME/Library/LaunchAgents" "$LOG_DIR"
chmod 700 "$IDENTITY_DIR"
install -m 700 "$INTERACTIVE_HELPER" "$BASE_DIR/interactive-macos.py"
if python3 "$BASE_DIR/interactive-macos.py" status | rg -q 'interactive=True'; then
  python3 "$BASE_DIR/interactive-macos.py" stop
fi

if [[ ! -f "$CLI" ]]; then
  TMP="$BASE_DIR/.build-$PIN"
  rm -rf "$TMP"
  git clone --quiet https://github.com/LibreChat-AI/code-interpreter.git "$TMP"
  git -C "$TMP" checkout --quiet --detach "$PIN"
  npm ci --prefix "$TMP/packages/code" --no-audit --no-fund
  npm run build --prefix "$TMP/packages/code"
  rm -rf "$RELEASE_DIR"
  mv "$TMP" "$RELEASE_DIR"
fi

# The pinned worker has no local manual checkpoint upstream. Integrate and
# rebuild before registration; a changed upstream source fails closed.
node "$APPROVAL_PATCH" "$RELEASE_DIR" prepare
npm run build --prefix "$RELEASE_DIR/packages/code" --ignore-scripts
node "$APPROVAL_PATCH" "$RELEASE_DIR" runtime

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

case "${MISSION_AI_CODE_REFRESH_IDENTITY:-false}" in
  true|false) ;;
  *) echo "MISSION_AI_CODE_REFRESH_IDENTITY must be true or false" >&2; exit 1 ;;
esac

if [[ ! -f "$IDENTITY_FILE" || ${MISSION_AI_CODE_REFRESH_IDENTITY:-false} == true ]]; then
  PAIR_CODE="${MISSION_AI_CODE_PAIRING_CODE:-}"
  if [[ -z "$PAIR_CODE" ]]; then
    PAIR_CODE="$(security find-generic-password -a "$USER" -s "$PAIR_SERVICE" -w 2>/dev/null || true)"
  fi
  if [[ -z "$PAIR_CODE" ]]; then
    read -r -s -p "Mission AI Code pairing code: " PAIR_CODE
    echo
  fi
  if [[ -f "$IDENTITY_FILE" ]]; then
    # Pair to a private replacement first so a failed or expired code leaves
    # the existing worker identity intact.
    REPLACEMENT="$IDENTITY_DIR/.$WORKER_ID.pending-$$.json"
    [[ ! -e "$REPLACEMENT" ]] || { echo "Pairing replacement path exists" >&2; exit 1; }
    trap '[[ ! -e "$REPLACEMENT" ]] || rm -- "$REPLACEMENT"' EXIT
    node "$CLI" pair "$CODE_API_URL" "$PAIR_CODE" --worker-id "$WORKER_ID" --identity "$REPLACEMENT"
    mv -- "$REPLACEMENT" "$IDENTITY_FILE"
    trap - EXIT
  else
    node "$CLI" pair "$CODE_API_URL" "$PAIR_CODE" --worker-id "$WORKER_ID" --identity "$IDENTITY_FILE"
  fi
  unset PAIR_CODE
  security delete-generic-password -a "$USER" -s "$PAIR_SERVICE" >/dev/null 2>&1 || true
fi

NODE_PATH="$(command -v node)"
PYTHON_PATH="$(command -v python3)"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.missionai.code-worker</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$CLI</string>
    <string>run</string>
$WORKSPACE_ARGUMENTS
    <string>--workspace-lease-slots</string>
    <string>2</string>
    <string>--allow-workspace-writes</string>
    <string>--allow-workspace-commands</string>
    <string>--command-sandbox</string>
    <string>native-srt</string>
    <string>--command-policy-preset</string>
    <string>restricted</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$DOC_BIN:$(dirname "$NODE_PATH"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key><string>production</string>
    <key>LIBRECHAT_CODE_WORKER_ID</key><string>$WORKER_ID</string>
    <key>LIBRECHAT_CODE_IDENTITY_FILE</key><string>$IDENTITY_FILE</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/code-worker.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/code-worker-error.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/com.missionai.code-worker" >/dev/null 2>&1 || true
for attempt in 1 2 3; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then break; fi
  if (( attempt == 3 )); then
    echo "Mission AI code worker could not be registered with launchd" >&2
    exit 1
  fi
  sleep 1
done
launchctl enable "gui/$(id -u)/com.missionai.code-worker"
launchctl kickstart -k "gui/$(id -u)/com.missionai.code-worker"

cat > "$WATCHDOG_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.missionai.code-worker-approval-watchdog</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON_PATH</string>
    <string>$BASE_DIR/interactive-macos.py</string>
    <string>reconcile</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>30</integer>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/com.missionai.code-worker-approval-watchdog" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$WATCHDOG_PLIST"

echo "Mission AI code worker installed."
echo "Pinned worker: $PIN"
echo "Identity: $IDENTITY_FILE"
echo "Logs: $LOG_DIR/code-worker.log"
