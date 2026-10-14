# Local mutation approval

The Windows and Mac installers allow a fixed set of browser actions and scoped
file writes and moves to run in the background. The Windows list is saved in the
per-user bridge settings; the Mac list is in its LaunchAgent. Local file access
stays within Desktop, Documents, and Downloads. Remote tool arguments cannot
extend the list.

Other mutations require a text-only local terminal preview of the exact tool
and arguments, followed by exactly `y` and Enter for that one operation.
Approval expires with the request; concurrent mutations are rejected. A hidden
background companion has no interactive terminal, so those operations fail with
`local_manual_approval_required`.

The code-worker installer now integrates this shared checkpoint into the pinned
worker before coding dispatch. Its build and synthetic daemon-refusal test are
separate from companion tests. The installed worker remains disabled until the
patched runtime, pairing repair and real manual approval acceptance pass. Do not
enable it based on companion tests alone. Use separate interactive terminals
for companion and coding sessions so one keyboard reply cannot reach two readers.
