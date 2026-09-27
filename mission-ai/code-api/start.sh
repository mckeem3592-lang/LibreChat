#!/usr/bin/env bash
set -euo pipefail

ROOT="${PWD}/.mission-ai-code-api"
export SERVICE_PORT="${PORT:-10000}"

exec node "$ROOT/service/.build-service/src/api-server.js"
