# Local mutation approval

Mac and Chrome mutations require a text-only local terminal preview of the exact
tool and arguments, followed by exactly `y` and Enter for that one operation.
Approval cannot arrive in remote tool arguments. It expires with the request;
concurrent mutations are rejected. Read-only inventory/state/screenshot calls
remain available.

The launchd background companion has no interactive terminal, so it fails closed
with `local_manual_approval_required`. It must not start a foreground terminal or
silently bypass this checkpoint. A user-controlled interactive session will be
needed for mutation validation. This document does not authorize starting it.

The code-worker installer now integrates this shared checkpoint into the pinned
worker before coding dispatch. Its build and synthetic daemon-refusal test are
separate from companion tests. The installed worker remains disabled until the
patched runtime, pairing repair and real manual approval acceptance pass. Do not
enable it based on companion tests alone. Use separate interactive terminals
for companion and coding sessions so one keyboard reply cannot reach two readers.
