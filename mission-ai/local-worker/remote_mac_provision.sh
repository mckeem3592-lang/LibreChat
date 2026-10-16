#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# The office launcher sends only these values as JSON over the SSH connection's stdin.
if [[ ${1:-} == --env-stdin ]]; then
  exec python3 -c '
import json
import os
import sys

allowed = {
    "LOCAL_MCP_PUBLIC_URL",
    "LOCAL_MCP_TOKEN",
    "LOCAL_MCP_OWNER_USER_ID",
    "LOCAL_MCP_ALLOWED_ORIGINS",
    "LOCAL_MCP_ROOT",
}
values = json.load(sys.stdin)
if not isinstance(values, dict) or not values or set(values) - allowed:
    raise SystemExit("Invalid worker environment payload")
if any(not isinstance(value, str) or "\0" in value for value in values.values()):
    raise SystemExit("Invalid worker environment value")
environment = os.environ.copy()
environment.update(values)
os.execve("/bin/bash", ["/bin/bash", sys.argv[1]], environment)
' "$0"
fi

for name in LOCAL_MCP_PUBLIC_URL LOCAL_MCP_TOKEN LOCAL_MCP_OWNER_USER_ID LOCAL_MCP_ALLOWED_ORIGINS; do
  [[ -n ${!name:-} ]] || { printf 'Missing %s\n' "$name" >&2; exit 1; }
  export "$name"
done
export LOCAL_MCP_ROOT="${LOCAL_MCP_ROOT:-$HOME/Documents}"
[[ -d "$LOCAL_MCP_ROOT" ]] || { printf 'LOCAL_MCP_ROOT is not a directory\n' >&2; exit 1; }
[[ "$LOCAL_MCP_OWNER_USER_ID" =~ ^[[:xdigit:]]{24}$ ]] ||
  { printf 'LOCAL_MCP_OWNER_USER_ID must be 24 hexadecimal characters\n' >&2; exit 1; }
[[ ${#LOCAL_MCP_TOKEN} -ge 40 ]] ||
  { printf 'LOCAL_MCP_TOKEN must be at least 40 characters\n' >&2; exit 1; }

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
worker="$script_dir/local_mcp_agent.py"
venv="$script_dir/.venv-local-mcp"
log_dir="$HOME/Library/Logs/MissionAI"
log_file="$log_dir/local-mcp-worker.log"
pid_file="$log_dir/local-mcp-worker.pid"
[[ -f "$worker" ]] || { printf 'Worker script is missing\n' >&2; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' ||
  { printf 'Python 3.11 or newer is required\n' >&2; exit 1; }

mkdir -p "$log_dir"
chmod 700 "$log_dir"
touch "$log_file"
chmod 600 "$log_file"

if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  printf 'Worker already running (PID %s); stop it before applying new environment\n' "$(cat "$pid_file")" >&2
  exit 1
fi

# Refuse to replace an unrelated listener on the worker's loopback port.
if python3 -c 'import socket,sys; s=socket.socket(); s.settimeout(1); result=s.connect_ex(("127.0.0.1",5000)); s.close(); sys.exit(0 if result == 0 else 1)'; then
  printf 'Port 5000 is already in use\n' >&2
  exit 1
fi

python3 -m venv "$venv"
"$venv/bin/python" -m pip install --no-input --disable-pip-version-check \
  'mcp==2.3.0' 'python-docx==1.2.0' 'openpyxl==3.1.5' \
  'playwright==1.63.0' 'uvicorn==0.53.0' 'pymupdf==1.26.6'
"$venv/bin/python" -m playwright install chromium
"$venv/bin/python" -c 'from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    browser.close()'
"$venv/bin/python" -m py_compile "$worker"

nohup "$venv/bin/python" -u "$worker" >>"$log_file" 2>&1 </dev/null &
worker_pid=$!
printf '%s\n' "$worker_pid" >"$pid_file"
chmod 600 "$pid_file"

for _ in {1..15}; do
  if ! kill -0 "$worker_pid" 2>/dev/null; then
    rm -f "$pid_file"
    printf 'Worker exited during startup; inspect %s\n' "$log_file" >&2
    exit 1
  fi
  if python3 -c 'import socket,sys; s=socket.socket(); s.settimeout(1); result=s.connect_ex(("127.0.0.1",5000)); s.close(); sys.exit(0 if result == 0 else 1)'; then
    printf 'Worker listening on 127.0.0.1:5000 (PID %s); log: %s\n' "$worker_pid" "$log_file"
    exit 0
  fi
  sleep 1
done

kill "$worker_pid" 2>/dev/null || true
rm -f "$pid_file"
printf 'Worker did not bind port 5000; inspect %s\n' "$log_file" >&2
exit 1
