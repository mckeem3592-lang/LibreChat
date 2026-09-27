#!/usr/bin/env bash
set -euo pipefail

PIN="67d75d859aee891923c40cde1db073489d74a424"
ROOT="${PWD}/.mission-ai-code-api"

rm -rf "$ROOT"
git clone --quiet https://github.com/LibreChat-AI/code-interpreter.git "$ROOT"
git -C "$ROOT" checkout --quiet --detach "$PIN"

npm ci --prefix "$ROOT/service" --no-audit --no-fund
npm run build --prefix "$ROOT/service"
cp "$ROOT/service/src/matplotlib-async.py" "$ROOT/service/.build-service/src/matplotlib-async.py"

printf 'Pinned Code API build: %s\n' "$PIN"
