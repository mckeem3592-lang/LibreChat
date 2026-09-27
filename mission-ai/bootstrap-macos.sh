#!/bin/zsh
set -euo pipefail

SOURCE_DIR="$HOME/.local/share/mission-ai/source"
REPO_URL="https://github.com/mckeem3592-lang/LibreChat.git"
BRANCH="mission-ai-v1"

if ! command -v git >/dev/null 2>&1; then
  echo "Git is required. Install Xcode Command Line Tools, then rerun."
  exit 1
fi

mkdir -p "$(dirname "$SOURCE_DIR")"
if [[ -d "$SOURCE_DIR/.git" ]]; then
  git -C "$SOURCE_DIR" fetch --quiet origin "$BRANCH"
  git -C "$SOURCE_DIR" checkout --quiet "$BRANCH"
  git -C "$SOURCE_DIR" reset --hard "origin/$BRANCH"
else
  git clone --quiet --branch "$BRANCH" --single-branch "$REPO_URL" "$SOURCE_DIR"
fi

zsh "$SOURCE_DIR/mission-ai/companion/install-macos.sh"
bash "$SOURCE_DIR/mission-ai/code-worker/install-macos.sh"

EXTENSION_DIR="$SOURCE_DIR/mission-ai/chrome-extension"

echo
echo "Mission AI local services are installed."
echo "Chrome extension folder: $EXTENSION_DIR"
echo
echo "Finish Chrome setup:"
echo "  1. Open chrome://extensions"
echo "  2. Enable Developer mode"
echo "  3. Load unpacked: $EXTENSION_DIR"
echo "  4. Open the Mission AI extension and choose Pair with Mac"
echo
echo "macOS may ask for Accessibility and Screen Recording permissions when"
echo "Mission AI first uses mouse/keyboard or screenshots. Approve Mission AI's"
echo "Node/Terminal process when prompted."
open -a "Google Chrome" "chrome://extensions/" >/dev/null 2>&1 || true
