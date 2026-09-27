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

## Install flow

1. LibreChat issues a one-time pairing code for the `Mission AI Mac` environment.
2. Run `bash install-macos.sh`.
3. Enter that one-time pairing code when prompted.
4. The launchd worker reconnects automatically after login/restart.

Additional project repositories can be registered later as explicit, non-overlapping
workspace roots. Do not register `~`, SSH/config directories, browser profiles, or
folders containing unrelated credentials.
