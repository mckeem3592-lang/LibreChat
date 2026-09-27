#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$ROOT_DIR/.env"
PLIST="$HOME/Library/LaunchAgents/com.missionai.companion.plist"
DEVICE_SERVICE="mission-ai-device-token"
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

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

: "${MISSION_AI_GATEWAY_URL:=https://mission-ai-gateway-mckee.onrender.com}"

if [[ -n "${MISSION_AI_DEVICE_TOKEN:-}" ]]; then
  security add-generic-password -U -a "$USER" -s "$DEVICE_SERVICE" -w "$MISSION_AI_DEVICE_TOKEN" >/dev/null
  unset MISSION_AI_DEVICE_TOKEN
fi

if ! security find-generic-password -a "$USER" -s "$DEVICE_SERVICE" -w >/dev/null 2>&1; then
  zsh "$ROOT_DIR/pair-macos.sh"
fi

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

rm -f "$ENV_FILE"
echo "Mission AI companion installed and started."
echo "Long-lived credentials are stored in macOS Keychain, not the LaunchAgent."
echo "Logs: $LOG_DIR"
echo "Next: Chrome > Extensions > Developer mode > Load unpacked > $ROOT_DIR/../chrome-extension"
