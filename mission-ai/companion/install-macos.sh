#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
PLIST="$HOME/Library/LaunchAgents/com.missionai.companion.plist"
LOG_DIR="$HOME/Library/Logs/MissionAI"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required. Install Node.js, then run this script again."
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if (( NODE_MAJOR < 20 )); then
  echo "Node.js 20+ is required. Current: $(node --version)"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ROOT_DIR/.env.example" "$ENV_FILE"
  echo "Created $ENV_FILE"
  echo "Fill in MISSION_AI_DEVICE_TOKEN and MISSION_AI_BROWSER_TOKEN, then rerun."
  exit 2
fi

set -a
source "$ENV_FILE"
set +a

: "${MISSION_AI_GATEWAY_URL:?MISSION_AI_GATEWAY_URL is required}"
: "${MISSION_AI_DEVICE_TOKEN:?MISSION_AI_DEVICE_TOKEN is required}"
: "${MISSION_AI_BROWSER_TOKEN:?MISSION_AI_BROWSER_TOKEN is required}"

cd "$ROOT_DIR"
npm install --omit=dev

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

NODE_PATH="$(command -v node)"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.missionai.companion</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_PATH</string>
    <string>$ROOT_DIR/companion.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MISSION_AI_GATEWAY_URL</key><string>$MISSION_AI_GATEWAY_URL</string>
    <key>MISSION_AI_DEVICE_TOKEN</key><string>$MISSION_AI_DEVICE_TOKEN</string>
    <key>MISSION_AI_BROWSER_TOKEN</key><string>$MISSION_AI_BROWSER_TOKEN</string>
    <key>MISSION_AI_DEVICE_ID</key><string>${MISSION_AI_DEVICE_ID:-mac-primary}</string>
    <key>MISSION_AI_BROWSER_PORT</key><string>${MISSION_AI_BROWSER_PORT:-8765}</string>
    <key>MISSION_AI_ALLOWED_APPS</key><string>${MISSION_AI_ALLOWED_APPS:-Google Chrome,Finder,Microsoft Excel,Microsoft Word,Microsoft PowerPoint}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/companion.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/companion-error.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/com.missionai.companion" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/com.missionai.companion"
launchctl kickstart -k "gui/$(id -u)/com.missionai.companion"

echo "Mission AI companion installed and started."
echo "Logs: $LOG_DIR"
echo "Next: Chrome > Extensions > Developer mode > Load unpacked > $ROOT_DIR/../chrome-extension"
