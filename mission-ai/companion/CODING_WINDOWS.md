# Windows scoped repository bridge

The Windows companion can expose one owner-selected Git checkout to the device
MCP as `repo_list`, `repo_read`, `repo_write`, `repo_check`,
`repo_start_check`, and `repo_check_status`. No new service or AI call is
required. The bridge is independent of the pinned Code API worker, whose native
Windows runtime is unsupported. It does not provide a shell, code sandbox,
automatic test selection, or a persistent agent job. A named check started in
the background keeps running across a gateway disconnect while the companion
process stays alive. Its result is held in companion memory for up to one hour
or 20 jobs; a companion restart loses that job. It does not continue model
reasoning.

Set `MISSION_AI_CODE_REPO_ROOT` to the absolute checkout path when running
`install-windows.ps1`. The installer records the path in the local per-user
`settings.json` and installs `diff-check` and `status` as named Git checks. The
setting survives later installer runs unless a new root is explicitly supplied.
Additional checks can be added **locally** to `codeRepository.checks` as a
command basename and argument array. A local `timeoutMs` may be set per check
from 1 second to 30 minutes (default 2 minutes); tool arguments can select
only a name, never provide a command line. Keep checks scoped to trusted
repositories. Repo files and command output enter the selected model context.

The installer grants the fixed repo write/check/start tools background permission in
the local allowlist. LibreChat still asks for every tool call. An existing file
must first be read: its `sha256` is required for the edit. A new file may be
created only under an existing directory. Hidden paths, links, and binary or
large text are rejected. Reopen the file and run a named check after writing.

For this project's no-credit acceptance, the local test creates a disposable
Git checkout, lists, reads and edits a file, then runs `git diff --check` and verifies
the actual failing exit code. The gateway MCP transport test verifies the six
tool routes. Neither test establishes that a paid model completed a coding task
through the deployed chat; record that result separately in the parity ledger.
