#!/bin/zsh
set -euo pipefail

BASE_DIR="$HOME/.local/share/mission-ai/document-tools"
VENV="$BASE_DIR/venv"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v python3 >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    brew install python
  else
    echo "Python 3.9+ is required. Install Python/Homebrew, then rerun."
    exit 1
  fi
fi

PYTHON_VERSION="$(python3 -c 'import sys; print(sys.version_info.major * 100 + sys.version_info.minor)')"
if (( PYTHON_VERSION < 309 )); then
  echo "Python 3.9+ is required. Current: $(python3 --version)"
  exit 1
fi

mkdir -p "$BASE_DIR"
if [[ ! -x "$VENV/bin/python" ]]; then
  python3 -m venv "$VENV"
fi

"$VENV/bin/python" -m pip install --disable-pip-version-check --upgrade pip >/dev/null
"$VENV/bin/python" -m pip install --disable-pip-version-check -r "$ROOT_DIR/requirements.txt"

"$VENV/bin/python" "$ROOT_DIR/verify.py"

echo "Mission AI document tools installed."
echo "Python: $VENV/bin/python"
