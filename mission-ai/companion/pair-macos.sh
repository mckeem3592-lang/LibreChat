#!/bin/zsh
set -euo pipefail

GATEWAY_URL="${MISSION_AI_GATEWAY_URL:-https://mission-ai-gateway-mckee.onrender.com}"
DEVICE_ID="${MISSION_AI_DEVICE_ID:-mac-primary}"
SERVICE="mission-ai-device-token"

if ! command -v curl >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
  echo "Mission AI pairing requires curl and Node.js 20+."
  exit 1
fi

PAIR_CODE="${MISSION_AI_PAIR_CODE:-}"
if [[ -z "$PAIR_CODE" ]]; then
  read -rs "PAIR_CODE?Mission AI pairing code: "
  echo
fi

PAYLOAD="$(node -e 'process.stdout.write(JSON.stringify({code:process.argv[1],deviceId:process.argv[2]}))' "$PAIR_CODE" "$DEVICE_ID")"
RESPONSE="$(curl --fail-with-body --silent --show-error   -H 'content-type: application/json'   --data "$PAYLOAD"   "$GATEWAY_URL/pair")"

DEVICE_TOKEN="$(printf '%s' "$RESPONSE" | node -e '
let body="";
process.stdin.on("data",(chunk)=>body+=chunk);
process.stdin.on("end",()=>{
  const parsed=JSON.parse(body);
  if(!parsed.ok || !parsed.deviceToken) process.exit(2);
  process.stdout.write(parsed.deviceToken);
});')"

security add-generic-password -U -a "$USER" -s "$SERVICE" -w "$DEVICE_TOKEN" >/dev/null
unset PAIR_CODE DEVICE_TOKEN RESPONSE PAYLOAD

echo "Mission AI Mac paired successfully. Device credential stored in macOS Keychain."
