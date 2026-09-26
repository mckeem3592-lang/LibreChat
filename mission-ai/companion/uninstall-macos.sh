#!/bin/zsh
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.missionai.companion.plist"
launchctl bootout "gui/$(id -u)/com.missionai.companion" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo "Mission AI companion launch agent removed. Project files and local .env were preserved."
