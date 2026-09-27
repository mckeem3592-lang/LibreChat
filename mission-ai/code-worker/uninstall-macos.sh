#!/bin/bash
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.missionai.code-worker.plist"
launchctl bootout "gui/$(id -u)/com.missionai.code-worker" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo "Mission AI code-worker launchd service removed."
echo "Paired identity and workspaces were preserved intentionally."
