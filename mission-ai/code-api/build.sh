#!/usr/bin/env bash
set -euo pipefail

PIN="67d75d859aee891923c40cde1db073489d74a424"
ROOT="${PWD}/.mission-ai-code-api"
LOCK_FILE="${PWD}/mission-ai/code-api/package-lock.json"
LOCK_HASH_FILE="${PWD}/mission-ai/code-api/dependency-lock.sha256"

[[ -f "$LOCK_FILE" && -f "$LOCK_HASH_FILE" ]] || {
  printf 'Code API requires its reviewed lockfile and fingerprint.\n' >&2
  exit 1
}
EXPECTED_LOCK_SHA256="$(cat "$LOCK_HASH_FILE")"
[[ "$EXPECTED_LOCK_SHA256" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'Code API dependency fingerprint is invalid.\n' >&2
  exit 1
}
verify_lock() {
  local actual
  actual="$(shasum -a 256 "$1" | awk '{print $1}')"
  if [[ "$actual" != "$EXPECTED_LOCK_SHA256" ]]; then
    printf 'Code API dependency lock mismatch. Expected %s, got %s\n' \
      "$EXPECTED_LOCK_SHA256" "$actual" >&2
    exit 1
  fi
}
verify_lock "$LOCK_FILE"

rm -rf "$ROOT"
git clone --quiet https://github.com/LibreChat-AI/code-interpreter.git "$ROOT"
git -C "$ROOT" checkout --quiet --detach "$PIN"

# Retain exact reviewed bytes; do not resolve upstream semver ranges during deployment.
cp "$LOCK_FILE" "$ROOT/service/package-lock.json"
npm ci --prefix "$ROOT/service" --include=dev --ignore-scripts --no-audit --no-fund
verify_lock "$ROOT/service/package-lock.json"
# Only the pinned explicit build runs, without dependency lifecycle or pre/post hooks.
npm run build --prefix "$ROOT/service" --ignore-scripts
cp "$ROOT/service/src/matplotlib-async.py" "$ROOT/service/.build-service/src/matplotlib-async.py"

printf 'Pinned Code API build: %s\n' "$PIN"
printf 'Reviewed Code API dependency lock: %s\n' "$EXPECTED_LOCK_SHA256"
