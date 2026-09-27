#!/bin/zsh
set -u

COMPANION_LABEL="com.missionai.companion"
WORKER_LABEL="com.missionai.code-worker"
BROWSER_SERVICE="mission-ai-browser-token"
DEVICE_SERVICE="mission-ai-device-token"
HEALTH_URL="http://127.0.0.1:8766/health"
IDENTITY_FILE="$HOME/.config/librechat/code/mac-primary-code.json"
DOC_VERIFY="$HOME/.local/share/mission-ai/source/mission-ai/document-tools/verify.py"
DOC_PYTHON="$HOME/.local/share/mission-ai/document-tools/venv/bin/python"

PASS=0
WARN=0
FAIL=0

ok() {
  printf "✅ %s\n" "$1"
  PASS=$((PASS + 1))
}

warn() {
  printf "🟡 %s\n" "$1"
  WARN=$((WARN + 1))
}

fail() {
  printf "❌ %s\n" "$1"
  FAIL=$((FAIL + 1))
}

launchd_running() {
  launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1
}

printf "\nMISSION AI / MAC ACCEPTANCE\n"
printf "===========================\n"

if security find-generic-password -a "$USER" -s "$DEVICE_SERVICE" -w >/dev/null 2>&1; then
  ok "Device credential is stored in macOS Keychain"
else
  fail "Device credential missing — run Mission AI pairing"
fi

BROWSER_TOKEN="$(security find-generic-password -a "$USER" -s "$BROWSER_SERVICE" -w 2>/dev/null || true)"
if [[ -n "$BROWSER_TOKEN" ]]; then
  ok "Browser bridge credential is stored in macOS Keychain"
else
  fail "Browser bridge credential missing — start/reinstall the companion"
fi

if launchd_running "$COMPANION_LABEL"; then
  ok "Mission AI companion LaunchAgent is loaded"
else
  fail "Mission AI companion LaunchAgent is not loaded"
fi

if launchd_running "$WORKER_LABEL"; then
  ok "LibreChat code worker LaunchAgent is loaded"
else
  fail "LibreChat code worker LaunchAgent is not loaded"
fi

if [[ -f "$IDENTITY_FILE" ]]; then
  ok "Code-worker identity exists"
else
  fail "Code-worker identity missing — pair the Mac code worker"
fi

if [[ -x "$DOC_PYTHON" && -f "$DOC_VERIFY" ]]; then
  if "$DOC_PYTHON" "$DOC_VERIFY" >/dev/null 2>&1; then
    ok "Excel/Word/PowerPoint/PDF toolchain is verified"
  else
    fail "Document toolchain verification failed — rerun bootstrap"
  fi
else
  fail "Document toolchain is not installed"
fi

if [[ -n "$BROWSER_TOKEN" ]]; then
  HEALTH="$(curl --silent --show-error --max-time 10     -H "Authorization: Bearer $BROWSER_TOKEN"     "$HEALTH_URL" 2>/dev/null || true)"

  if [[ -n "$HEALTH" ]]; then
    HEALTH_RESULT="$(HEALTH_JSON="$HEALTH" node <<'NODE'
const body = JSON.parse(process.env.HEALTH_JSON || '{}');
const values = [
  body.gatewayConnected ? 'gateway:ok' : 'gateway:fail',
  body.extensionConnected ? 'extension:ok' : 'extension:fail',
  body.accessibility?.ok ? 'accessibility:ok' : 'accessibility:fail',
  body.screenRecording?.ok ? 'screen:ok' : 'screen:fail',
  body.accessibility?.error ? `accessibility_error:${body.accessibility.error}` : '',
  body.screenRecording?.error ? `screen_error:${body.screenRecording.error}` : '',
].filter(Boolean);
process.stdout.write(values.join('\n'));
NODE
)" 2>/dev/null || HEALTH_RESULT=""

    if printf '%s\n' "$HEALTH_RESULT" | grep -q '^gateway:ok$'; then
      ok "Mac companion is connected to the Mission AI gateway"
    else
      fail "Mac companion is not connected to the cloud gateway"
    fi

    if printf '%s\n' "$HEALTH_RESULT" | grep -q '^extension:ok$'; then
      ok "Chrome extension is paired and connected"
    else
      warn "Chrome extension is not connected — load/pair the unpacked extension"
    fi

    if printf '%s\n' "$HEALTH_RESULT" | grep -q '^accessibility:ok$'; then
      ok "macOS Accessibility control is available"
    else
      warn "macOS Accessibility permission is not available yet"
    fi

    if printf '%s\n' "$HEALTH_RESULT" | grep -q '^screen:ok$'; then
      ok "macOS Screen Recording is available"
    else
      warn "macOS Screen Recording permission is not available yet"
    fi
  else
    fail "Local companion health endpoint is unreachable"
  fi
fi

unset BROWSER_TOKEN HEALTH HEALTH_RESULT 2>/dev/null || true

printf "\nSUMMARY: %d pass / %d action-needed / %d failed\n" "$PASS" "$WARN" "$FAIL"

if (( FAIL > 0 )); then
  exit 2
fi
if (( WARN > 0 )); then
  exit 1
fi
exit 0
