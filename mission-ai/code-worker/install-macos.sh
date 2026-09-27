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
LOG_DIR="$HOME/Library/Logs/MissionAI"
DOC_BIN="$HOME/.local/share/mission-ai/document-tools/venv/bin"
CLI="$RELEASE_DIR/packages/code/dist/cli.js"
PAIR_SERVICE="mission-ai-code-pairing-code"

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

ln -sfn "$RELEASE_DIR" "$CURRENT_LINK"

if [[ ! -f "$IDENTITY_FILE" ]]; then
  PAIR_CODE="${MISSION_AI_CODE_PAIRING_CODE:-}"
  if [[ -z "$PAIR_CODE" ]]; then
    PAIR_CODE="$(security find-generic-password -a "$USER" -s "$PAIR_SERVICE" -w 2>/dev/null || true)"
  fi
  if [[ -z "$PAIR_CODE" ]]; then
    read -r -s -p "Mission AI Code pairing code: " PAIR_CODE
    echo
  fi
  node "$CLI" pair "$CODE_API_URL" "$PAIR_CODE" --worker-id "$WORKER_ID" --identity "$IDENTITY_FILE"
  unset PAIR_CODE
fi

NODE_PATH="$(command -v node)"
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
    <string>--default-workspace</string>
    <string>--workspace-lease-slots</string>
    <string>2</string>
    <string>--allow-workspace-writes</string>
    <string>--allow-workspace-commands</string>
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
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/com.missionai.code-worker"
launchctl kickstart -k "gui/$(id -u)/com.missionai.code-worker"

echo "Mission AI code worker installed."
echo "Pinned worker: $PIN"
echo "Identity: $IDENTITY_FILE"
echo "Logs: $LOG_DIR/code-worker.log"
