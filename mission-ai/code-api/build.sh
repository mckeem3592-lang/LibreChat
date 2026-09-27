#!/usr/bin/env bash
set -euo pipefail

PIN="67d75d859aee891923c40cde1db073489d74a424"
ROOT="${PWD}/.mission-ai-code-api"

rm -rf "$ROOT"
git clone --quiet https://github.com/LibreChat-AI/code-interpreter.git "$ROOT"
git -C "$ROOT" checkout --quiet --detach "$PIN"

LOCK_HASH_FILE="${PWD}/mission-ai/code-api/dependency-lock.sha256"

npm install --prefix "$ROOT/service" --include=dev --package-lock-only --ignore-scripts --no-audit --no-fund
ACTUAL_LOCK_SHA256="$(shasum -a 256 "$ROOT/service/package-lock.json" | awk '{print $1}')"
printf 'Resolved Code API dependency lock: %s\n' "$ACTUAL_LOCK_SHA256"

if [[ -f "$LOCK_HASH_FILE" ]]; then
  EXPECTED_LOCK_SHA256="$(tr -d '[:space:]' < "$LOCK_HASH_FILE")"
  if [[ -z "$EXPECTED_LOCK_SHA256" || "$ACTUAL_LOCK_SHA256" != "$EXPECTED_LOCK_SHA256" ]]; then
    printf 'Code API dependency lock mismatch. Expected %s, got %s\n' \
      "$EXPECTED_LOCK_SHA256" "$ACTUAL_LOCK_SHA256" >&2
    exit 1
  fi
fi

npm ci --prefix "$ROOT/service" --include=dev --no-audit --no-fund
npm run build --prefix "$ROOT/service"
cp "$ROOT/service/src/matplotlib-async.py" "$ROOT/service/.build-service/src/matplotlib-async.py"

printf 'Pinned Code API build: %s\n' "$PIN"
