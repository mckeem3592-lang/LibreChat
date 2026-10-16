#!/usr/bin/env python3
"""Run and review the paired Mac code worker in a detached local terminal."""

import hashlib
import json
import os
import plistlib
import re
import subprocess
import sys
import time
from pathlib import Path

LABEL = "com.missionai.code-worker"
SESSION = "mission-ai-code-approval"
BASE = Path.home() / ".local/share/mission-ai/code-worker"
PLIST = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
LOG = BASE / "approval-session.log"
SCREEN_RC = BASE / "approval-screenrc"
ACTIVE = BASE / "approval-session-active"
PROMPT = "Type exactly y then Enter to authorize this one action:"
MARKER = "MISSION AI ACTION PREVIEW\n"


def run(*args, check=True, capture=False):
    return subprocess.run(
        args,
        check=check,
        text=True,
        capture_output=capture,
        env={**os.environ, "TERM": "xterm-256color"},
    )


def screen_running():
    result = run("screen", "-ls", check=False, capture=True)
    return bool(re.search(rf"\d+\.{re.escape(SESSION)}\s+\((?:Detached|Attached)\)", result.stdout))


def daemon_running():
    return run("launchctl", "print", f"gui/{os.getuid()}/{LABEL}", check=False,
               capture=True).returncode == 0


def restore_daemon():
    if not daemon_running():
        run("launchctl", "bootstrap", f"gui/{os.getuid()}", str(PLIST))
    run("launchctl", "enable", f"gui/{os.getuid()}/{LABEL}")
    run("launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{LABEL}")


def worker():
    with PLIST.open("rb") as handle:
        definition = plistlib.load(handle)
    command = definition["ProgramArguments"]
    environment = {**os.environ, **definition.get("EnvironmentVariables", {})}
    os.execve(command[0], command, environment)


def start():
    if screen_running():
        if daemon_running():
            raise RuntimeError("Both worker modes are active; stop the detached session")
        print("Interactive worker already running")
        return
    with PLIST.open("rb") as handle:
        definition = plistlib.load(handle)
    if definition.get("Label") != LABEL:
        raise RuntimeError("Unexpected launchd worker definition")
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(BASE, 0o700)
    LOG.write_bytes(b"")
    LOG.chmod(0o600)
    quoted_log = str(LOG).replace("\\", "\\\\").replace('"', '\\"')
    SCREEN_RC.write_text(
        f'startup_message off\ndeflog on\nlogfile "{quoted_log}"\nlogfile flush 0\n',
        encoding="utf-8",
    )
    SCREEN_RC.chmod(0o600)
    ACTIVE.write_text("interactive\n", encoding="utf-8")
    ACTIVE.chmod(0o600)
    run("launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}", check=False,
        capture=True)
    for _ in range(20):
        if not daemon_running():
            break
        time.sleep(0.1)
    if daemon_running():
        ACTIVE.unlink(missing_ok=True)
        raise RuntimeError("The ordinary worker could not be stopped")
    try:
        run("screen", "-c", str(SCREEN_RC), "-dmS", SESSION, sys.executable,
            str(Path(__file__).resolve()), "worker")
        time.sleep(1)
        if not screen_running():
            raise RuntimeError("Detached worker did not stay running")
    except Exception:
        restore_daemon()
        ACTIVE.unlink(missing_ok=True)
        raise
    print("Interactive worker running in a detached local terminal")


def current_preview():
    if not screen_running():
        raise RuntimeError("Interactive worker is not running")
    if not LOG.exists() or time.time() - LOG.stat().st_mtime > 15:
        raise RuntimeError("No fresh local approval prompt")
    data = LOG.read_text(encoding="utf-8", errors="replace")
    position = data.rfind(MARKER)
    if position < 0:
        raise RuntimeError("No local action preview")
    remaining = data[position + len(MARKER):].lstrip()
    action, end = json.JSONDecoder().raw_decode(remaining)
    if remaining[end:].strip() != PROMPT:
        raise RuntimeError("Local approval prompt is no longer current")
    digest = hashlib.sha256(
        json.dumps(action, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    return action, digest


def review():
    action, digest = current_preview()
    print(json.dumps(action, indent=2))
    print(f"Exact-action digest: {digest}")


def approve(expected):
    action, digest = current_preview()
    if not re.fullmatch(r"[0-9a-f]{64}", expected) or expected != digest:
        raise RuntimeError("Approval digest does not match the current action")
    run("screen", "-S", SESSION, "-p", "0", "-X", "stuff", "y\r")
    print(f"Approved one local action: {action['tool']}")


def stop():
    if screen_running():
        run("screen", "-S", SESSION, "-X", "quit")
        for _ in range(20):
            if not screen_running():
                break
            time.sleep(0.1)
        if screen_running():
            raise RuntimeError("Detached worker did not stop; launchd was not restarted")
    restore_daemon()
    ACTIVE.unlink(missing_ok=True)
    if LOG.exists():
        LOG.write_bytes(b"")
    print("Normal launchd worker restored")


def reconcile():
    if (ACTIVE.exists() and time.time() - ACTIVE.stat().st_mtime > 5
            and not screen_running()):
        restore_daemon()
        ACTIVE.unlink()
        if LOG.exists():
            LOG.write_bytes(b"")
        print("Detached session ended; normal launchd worker restored")


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: interactive-macos.py start|review|approve DIGEST|stop|status|reconcile")
    command = sys.argv[1]
    if command == "worker" and len(sys.argv) == 2:
        worker()
    elif command == "start" and len(sys.argv) == 2:
        start()
    elif command == "review" and len(sys.argv) == 2:
        review()
    elif command == "approve" and len(sys.argv) == 3:
        approve(sys.argv[2])
    elif command == "stop" and len(sys.argv) == 2:
        stop()
    elif command == "status" and len(sys.argv) == 2:
        print(f"interactive={screen_running()} daemon={daemon_running()} active={ACTIVE.exists()}")
    elif command == "reconcile" and len(sys.argv) == 2:
        reconcile()
    else:
        raise SystemExit("Usage: interactive-macos.py start|review|approve DIGEST|stop|status|reconcile")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        raise SystemExit(f"Interactive worker: {exc}") from exc
