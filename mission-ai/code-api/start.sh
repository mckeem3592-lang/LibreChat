#!/usr/bin/env bash
set -euo pipefail

ROOT="${PWD}/.mission-ai-code-api"
export SERVICE_PORT="${PORT:-10000}"
[[ ${CODEAPI_AUTH_PROVIDER-} == librechat-jwt &&
   ${MISSION_AI_CODE_OWNER_ID-} =~ ^[a-f0-9]{24}$ &&
   ${CODEAPI_JWT_SINGLE_TENANT_ID-} == mission-ai-chat-test ]] || {
  printf 'Mission AI Code API requires its fixed owner and tenant binding.\n' >&2
  exit 1
}

exec node "$ROOT/service/.build-service/src/service-api.js"
