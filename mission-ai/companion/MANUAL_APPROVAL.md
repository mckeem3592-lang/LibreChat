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

The separate code worker remains disabled pending its own command/file preview
integration and pairing repair. The companion gate does not cover code-worker
filesystem execution. Do not enable that worker based on these companion tests.
