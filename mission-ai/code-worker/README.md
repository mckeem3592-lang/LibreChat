# Mission AI macOS Code Worker

This component provides workspace-scoped coding tools on the personal Mac using
LibreChat's official outbound `@librechat/code` bridge.

## Security boundary

- Worker revision is pinned to `67d75d859aee891923c40cde1db073489d74a424`, the revision exercised by the
  current LibreChat checkout's macOS acceptance workflow.
- No inbound Internet port is opened.
- The paired Ed25519 identity stays under `~/.config/librechat/code/`.
- The initial workspace is app-owned and private; the home directory is never
  registered as a workspace.
- File writes and commands are sandboxed by the worker's native macOS SRT/Seatbelt
  boundary.
- Network egress is denied by default because no command allowlist is configured.
- LibreChat tool approval remains an independent per-call control.
- The Mission AI installer verifies the pinned worker source fingerprint and
  adds the shared local text-preview/literal-`y` checkpoint before any coding
  mutation dispatch. It snapshots the exact request before approval.
- Daemon file writes, commands and programmatic execution fail closed. Static
  reads remain available. Named environment scripts and implicit worktree
  provisioning are refused because their resolved changes cannot be previewed.
- `interactive-macos.py` can temporarily replace the read-only launchd process
  with the same paired worker in a detached local terminal. It prints the exact
  pending action and a SHA-256 digest; `approve DIGEST` sends one literal `y`
  only while that same local prompt is fresh. An expired or already answered
  prompt cannot be replayed. The private preview log is stored with mode 0600.
  A small launchd watchdog restores the ordinary worker if the detached
  terminal ends unexpectedly.

## Install flow

1. LibreChat issues a one-time pairing code for the `Mission AI Mac` environment.
2. Run `bash install-macos.sh`.
3. Enter that one-time pairing code when prompted.
4. The launchd worker reconnects automatically after login/restart for reads.
   Mutations require a user-controlled interactive local terminal. Keep the
   worker disabled until the patched build, pairing and live approval checks pass.

For an existing checkout inside the default worker directory, set
`MISSION_AI_CODE_WORKSPACE_DIR` to the checkout's absolute path when running
`install-macos.sh`. The installer registers that directory as `primary`, so
`workspace/package.json` in chat reads its root `package.json`. The path must
be inside LibreChat worker storage or `Documents/Codex`.

If Code API reports an invalid or expired worker credential, obtain a fresh
one-time pairing code through the owner-approved pairing flow, then rerun the
installer with `MISSION_AI_CODE_REFRESH_IDENTITY=true`. The installer pairs to
a private replacement file and replaces the old identity only after pairing
succeeds. It clears the temporary Keychain pairing code after use.

## Exact-action local approval handoff

The installed helper lives at `~/.local/share/mission-ai/code-worker/interactive-macos.py`.
Run `python3 .../interactive-macos.py start` to start the paired worker in a
detached local terminal and pause its normal launchd service. When LibreChat
shows a pending write or command, approve that specific card, then run
`python3 .../interactive-macos.py review` locally. Check its full JSON preview
against the intended action and pass the printed digest to
`python3 .../interactive-macos.py approve DIGEST` within 15 seconds. The worker
still enforces its own 20-second limit. Run `python3 .../interactive-macos.py
stop` to restore the ordinary read-only launchd service. The helper does not
create a remote approval endpoint or accept approval through tool arguments.

If the detached session ends unexpectedly, the watchdog restores launchd on
its next 30-second check after a five-second startup grace. `stop` restores it
immediately. No write or command can
execute through the headless worker without an interactive local approval.
Only one approval prompt can be active at a time.

Additional project repositories can be registered later as explicit, non-overlapping
workspace roots. Do not register `~`, SSH/config directories, browser profiles, or
folders containing unrelated credentials.
