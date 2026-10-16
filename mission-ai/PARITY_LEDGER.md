# Mission AI functional parity ledger

Last reviewed: 2026-10-16. Baseline: `mission-ai-v1` at `744d65f17` (PR #74).
Deployment: `mission-ai-chat-test-mckee` and `mission-ai-gateway-mckee` on Render.

The goal is to complete practical ChatGPT-like work with a manually selected
OpenAI, Claude, or Gemini model. A listed tool, passing unit test, healthy service,
or successful deployment is not an end-to-end model task. `Accepted` below requires
a signed-in model request that performs the action and returns a result verified by
reading the destination or artifact. No new paid model calls, paid services, or
recurring AI jobs are permitted for this project. Earlier paid-run evidence is
identified as such; it is not a fresh acceptance test.

| ID / workflow | Current implementation | Missing step | Windows status | Mac status | End-to-end result | Blocker |
| --- | --- | --- | --- | --- | --- | --- |
| C1: inspect scoped repository | Attached Code API, pinned `primary` Mac worker; Windows companion `repo_list`/`repo_read` with explicit local root | Repeat a selected-model read on deployed head | Windows installed bridge listed checkout and read `package.json`; gateway advertised `repo.scoped` at 14:41:56 UTC | PR #40 reported successful Claude read of checkout `package.json`; current Mac worker disconnected in checked window | **Installed Windows no-model pass; partial prior Mac model success** | Paid model call for fresh E2E; Mac worker connection/version |
| C2: edit repository files | Mac code worker `write_file` and patch preview; Windows `repo_write` requires prior sha256 | Prove deployed model edit/readback/diff/undo | Disposable repository edit/readback passed offline; installed live edit intentionally untried | Headless worker refuses mutations; detached `screen` helper requires exact local digest approval | **Offline Windows bridge pass; no complete model edit** | Paid model call and local Mac approval |
| C3: run checks and report changes | Mac Code API command execution; Windows `repo_check` only runs locally named checks | Run model-selected check and verify response cites real changes | Disposable Git diff check failed as expected and returned actual exit/output; installed `status` returned exit 0 | Commands require detached worker and local exact-action approval | **Offline and installed Windows check pass; model summary unverified** | Paid model call and local Mac approval |
| C4: continue long coding work in background | Core agent jobs/checkpointer code exists; active profile lacks `run_in_background`; Windows companion persists named check results on disk | Prove a selected-model coding job, gateway disconnect recovery, and Mac path | PR #74 worker installed; a real `status` check completed with exit 0 and was read by a fresh launcher process; gateway re-advertised `repo.scoped` at 15:43 UTC | Worker connection/daemon designed to persist, but mutating job awaits local operator | **Installed no-model background check recovery pass; model job unverified** | Active profile gate, paid model E2E, Mac approval |
| F1: scoped local file read/write | Device MCP `file_read`/`file_write`; companion confines paths and approvals | Read, mutate, reopen, and confirm ownership on each OS | Installed module passed create/read/stale-hash rejection/update/readback with a disposable workspace fixture and a temporary narrowed Documents root; actual configured Documents root is OneDrive and was not written | `mac-primary` disconnected during deploy and did not reconnect in the checked window | **Installed module no-model pass; configured device/model full cycle unverified** | Signed-in model call and paired-device acceptance; Windows configured OneDrive path is outside writable test workspace |
| F2: upload and analyze documents | PDF/DOCX/XLSX text extraction; bounded upload; optional Local Documents MCP; Mongo GridFS bytes and owner-scoped download link deployed in `53347905` | Compare production download bytes and verify model analysis against source | Local Mongo reconnect and byte readback passed; signed-in production PDF remains listed after a chat service restart and My Files exposes its authenticated download link | Local Documents bridge exists; per-user tool availability not proved | **Production no-model upload/list/link pass; production byte readback and model analysis unverified** | Browser download capture returned no file and browser downloads page is policy-blocked; paid model call prohibited |
| F3: create/edit/download DOCX, XLSX, PPTX, PDF | Edited-byte GridFS, owner-scoped publisher/download, Office validation, XLSX creator | Format-by-format create, edit, render/open, redeploy, download acceptance | Web client should work, local document editor not established | Local Documents bridge; PR #43 fixed first-response XLSX link | **Partial prior XLSX/document runs; suite incomplete** | Paid model call, connected document tool, render/open checks |
| F4: file search with citations | File text fallback exists; `fileSearch: false` | Durable ingestion, permission-scoped index, source spans and citation checks | Off | Off | **Not available** | Retrieval backend and storage; no paid index service approved |
| B1: enumerate/open/close browser tabs | Device MCP browser tools and companion/Chrome extension | Verify live extension runtime and tab identity through the model | Installed Windows extension manifest/background and companion files match repository SHA256; `windows-work` advertised `browser.page_extension`; live action unknown | PR #44 found an older installed extension; `mac-primary` did not reconnect in the checked post-deploy window | **Installed file revision verified; browser workflow unverified** | Chrome extension runtime and model acceptance |
| B2: click/type/save in connected sites | Snapshot-bound click/type, hidden/credential exclusions and retention checks | Save then reread a disposable item; distinguish DOM typing from server save | Bridge code exists, live result unknown | Gmail draft round trip remained unverified after PRs #44–#47 | **No verified save/read model cycle** | Extension version/permissions and paid model call |
| S1: GitHub read/edit/PR work | Owner-scoped GitHub editor MCP and code bridge | Verify one model task through changed-file readback, checks and PR result | Cloud MCP is OS-independent; access from Windows browser unverified | Cloud MCP is OS-independent; Mac client path unverified | **Tool exists; no accepted complete model task** | Paid model call and exact repo authorization |
| S2: email and other connected services | Browser bridge and selected MCP servers | Add scoped OAuth/native connectors or prove browser save/read/send with result receipts | Browser bridge unverified | Browser Gmail draft save/read unverified | **Not accepted** | Per-service authorization, extension readiness, paid model test |
| P1: Projects with reusable context | Owner-scoped project CRUD and chat grouping | Project instructions/files and verified context injection, deletion isolation | Web UI present, authenticated acceptance unverified | Same web UI status | **Grouping implementation only** | Schema lacks instructions/files; paid context test |
| M1: personal memory | Bounded manual CRUD; automatic memory agent off | Confirm CRUD and that a fresh chat uses only authorized memory | Web UI present, live result unknown | Same | **Unverified context use** | Paid fresh-chat check; autonomous extraction intentionally off |
| T1: schedules/background tasks | Owner-pinned schedule agent, schedule UI, engine and signed trigger | Verify listener-local admission response, then timed fire, retry, recovery and completion notice | Hosted engine is OS-independent; not accepted | Same | **Failed live disposable Run now**: retries dead-lettered Oct 16 while a chat deploy was starting; HTTP 200 non-JSON body, and no chat-controller entry log | Source of non-JSON response unproven; free Render sleep; recurring AI spend disallowed |
| K1: reusable skills/agents | General agents and skills code exists; single pinned schedule agent | Durable skill import, authorization, execution and user-facing lifecycle | `skills: false` | `skills: false` | **Not available** | Gated profile and storage/acceptance |
| R1: live web search and research | Tavily basic search, four results, 15-second timeout | Verify dated sources/citations; add source tracking for deeper research | Cloud feature; same status | Same | **Basic search configured; research unverified** | No no-cost model acceptance; narrow result set |
| I1: image create/edit | Default-off budget-gated Gemini device MCP image action and reference edit | Generate, edit, return/reopen image with settled cost | Cloud tool; same status | Same | **First paid attempt denied before provider**; no accepted image | Tool gate/provider acceptance and paid call |
| V1: speech and live voice | Speech-to-text UI, browser-local read-aloud | Audible STT/TTS check; duplex interruption/latency for live voice | Browser support/device permission unverified | Browser support/device permission unverified | **Read-aloud not audibly accepted; live voice absent** | Device/browser acceptance; live audio backend |
| X1: responsive long chat and cancellation | Context pruning, tokenizer init, client-disconnect abort; PR #68 bounds provider response read | Diagnose OOM, prove sustained long chats and actual incremental Claude streaming with safe accounting | Hosted route; same status | Same | **Offline bridge tests pass; live long-chat acceptance fails historically** | 512 MiB memory headroom; streaming/ledger redesign; paid E2E |
| X2: model routing and spend controls | Free Gemini default; manually selected Claude/OpenAI; monthly ledger | Verify selected model actually finishes representative task within budget on each route | Cloud feature; same status | Same | **Offline policy tests; live acceptance incomplete** | Paid calls prohibited for this project |

## Current acceptance sequence

1. Validate the installed Windows background check across a gateway disconnect.
   Complete C4's model job separately and test Mac.
   Model-driven acceptance remains unverified until a paid call is permitted.
2. Repair the proven schedule trigger contract before creating any recurring AI
   task. A one-shot no-provider delivery test may exercise the transport.
3. Make files and generated artifacts durable, then perform format-by-format
   reopen/download tests without a model.
4. Verify installed browser/device versions and source-to-destination readback.
5. Complete project context, retrieval, memory, voice, image, skills and deeper
   research in the priority order above, recording each test and blocker here.

The chat startup log on 2026-10-16 showed `runCode: true`, schedules exposed,
`fileSearch: false`, and `skills: false`. Render reported a memory sample near
533 MB against a 537 MB limit; the cause is not proven. The schedule trigger
returned HTTP 200 with `body=non_json`, `start=missing`, `conversation=false`,
then dead-lettered. PR #68 is a bounded-memory fix, not proof of OOM resolution.
The PR #69 gateway deploy `dep-db93emk9v7es73edca80` is live at
`234381b3`. The updated Windows companion reconnected at 14:41:54 UTC and
advertised browser, file and `repo.scoped` capabilities at 14:41:56 UTC. Its
installed module listed 38 checkout entries, read `package.json` and returned
exit 0 for the locally named `status` check. Those are no-model observations,
not model task acceptance. Mac worker connectivity and action acceptance are
still unverified.

PR #70 deployed gateway revision `de53ae86` (Render deploy
`dep-db93ho8473hc739v6pug`). The Windows companion's installed
`repo_start_check(status)` returned a running job followed by completed status
and exit 0. Gateway logs advertised `repo.scoped` after that deploy. An actual
model-driven coding job, restart recovery, and Mac path remain unverified.
The GridFS document-storage work passed a local MongoDB upload,
client-reconnect, byte-for-byte download and deletion test. PR #71 was merged,
but its first chat deploy failed on an isolated declaration build error. PR #72
fixed that error, and chat revision `eafdeee1` became live. A signed-in browser
uploaded a small PDF to the production chat; My Files listed it after reload.
That first check proved upload and metadata persistence after a page reload.
The PDF parser logged a `standardFontDataUrl` warning.

PR #73 deployed chat revision `53347905` (Render deploy
`dep-db945nbodcbs73cuf2fg`). The same PDF remained listed after that service
restart, and My Files exposed an owner-scoped download link. The browser
download capture did not provide a saved file for SHA256 comparison; a
`chrome://downloads` inspection was blocked by browser policy, so production
byte readback is **unverified**. Focused client Jest was blocked by a missing
local Babel plugin; production frontend build passed. Installed Windows
companion and browser extension files match the checkout hashes, but this does
not prove the loaded extension runtime or a model browser action.

The pinned upstream [code worker](https://github.com/LibreChat-AI/code-interpreter/blob/67d75d859aee891923c40cde1db073489d74a424/packages/code/README.md)
does not support native Windows; it documents WSL2 on a native Linux filesystem
as the local alternative. WSL2 is not installed on this Windows host. The new
Windows companion repository bridge deliberately exposes only a locally selected
checkout and named checks, with per-tool LibreChat approval. It does not provide
an arbitrary shell, persistent coding job, or a paid-model acceptance result.

PR #74 merged as `744d65f17`. Its Windows detached check worker was installed
locally and reconnected to the gateway. A named `status` check returned a job ID,
then a fresh launcher process read its durable completed result with exit 0. An
installed scoped-file module test used a disposable fixture under a temporary
workspace root and passed create/read/stale-hash rejection/update/readback. The
actual configured Documents root points into OneDrive and was not changed for
this test. Neither result proves a selected-model task.

The October 16 schedule Run now failed during a chat-service rollout. Render
logged repeated `http=200 body=non_json` start responses and no corresponding
chat-controller entry. The response origin remains unproven. Trigger dispatch
now prefers the current process's bound listener after initialization, retaining
the configured self URL only before a listener exists. A focused offline test
covers that routing choice; timed or model-driven schedule acceptance remains
unverified.
