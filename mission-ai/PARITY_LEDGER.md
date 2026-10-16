# Mission AI functional parity ledger

Last reviewed: 2026-10-16. Baseline: `mission-ai-v1` at `744a31a53` (PR #68).
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
| C1: inspect scoped repository | Attached Code API, pinned `primary` Mac worker; new Windows companion `repo_read` bridge with explicit local root | Deploy/install new bridge; confirm worker build and repeat a model read | Native upstream code worker unsupported; Windows companion bridge passed offline read, not installed/live yet | PR #40 reported successful Claude read of checkout `package.json`; current Mac worker disconnected in checked window | **Offline Windows bridge pass; partial prior Mac model success** | Paid model call for fresh E2E; Mac worker connection/version; Windows companion update |
| C2: edit repository files | Mac code worker `write_file` and patch preview; new Windows `repo_write` requires prior sha256 | Deploy/install bridge; prove model edit/readback/diff/undo | Disposable repository edit/readback passed offline; no live model action | Headless worker refuses mutations; detached `screen` helper requires exact local digest approval | **Offline Windows bridge pass; no complete model edit** | Paid model call, local Mac approval, Windows companion update |
| C3: run checks and report changes | Mac Code API command execution; new Windows `repo_check` only runs checks in local owner settings | Deploy/install bridge; run model-selected check and verify response cites real changes | Disposable Git diff check failed as expected and returned its actual exit/output offline | Commands require detached worker and local exact-action approval | **Offline Windows check pass; model summary unverified** | Paid model call, local Mac approval, Windows companion update |
| C4: continue long coding work in background | Agent jobs and Code API have stateful sessions; chat has context pruning | Persist/resume an actual coding job across disconnect/restart; report terminal state | No coding worker | Worker connection and daemon are designed to persist, but mutating job awaits local operator | **Unverified** | No no-cost model-run test; approval and job recovery unproven |
| F1: scoped local file read/write | Device MCP `file_read`/`file_write`; companion confines paths and approvals | Read, mutate, reopen, and confirm ownership on each OS | `windows-work` reconnected after gateway deploy and advertised `files.scoped`; action unverified | `mac-primary` disconnected during deploy and did not reconnect in the checked window | **Unverified full cycle** | Signed-in model call and paired-device acceptance |
| F2: upload and analyze documents | PDF/DOCX/XLSX text extraction; bounded upload; optional Local Documents MCP | Verify correct extraction and response against source; make general uploads durable | Browser upload available, Local Documents endpoint availability unknown | Local Documents bridge exists; per-user tool availability not proved | **Partial implementation** | Paid model acceptance; local uploads are instance-local |
| F3: create/edit/download DOCX, XLSX, PPTX, PDF | Edited-byte GridFS, owner-scoped publisher/download, Office validation, XLSX creator | Format-by-format create, edit, render/open, redeploy, download acceptance | Web client should work, local document editor not established | Local Documents bridge; PR #43 fixed first-response XLSX link | **Partial prior XLSX/document runs; suite incomplete** | Paid model call, connected document tool, render/open checks |
| F4: file search with citations | File text fallback exists; `fileSearch: false` | Durable ingestion, permission-scoped index, source spans and citation checks | Off | Off | **Not available** | Retrieval backend and storage; no paid index service approved |
| B1: enumerate/open/close browser tabs | Device MCP browser tools and companion/Chrome extension | Verify installed extension matches current protocol and tab identity | `windows-work` reconnected with `browser.page_extension`; live action/version unknown | PR #44 found an older installed extension; `mac-primary` did not reconnect in the checked post-deploy window | **Unverified on current install** | Extension reload/pairing and model acceptance |
| B2: click/type/save in connected sites | Snapshot-bound click/type, hidden/credential exclusions and retention checks | Save then reread a disposable item; distinguish DOM typing from server save | Bridge code exists, live result unknown | Gmail draft round trip remained unverified after PRs #44–#47 | **No verified save/read model cycle** | Extension version/permissions and paid model call |
| S1: GitHub read/edit/PR work | Owner-scoped GitHub editor MCP and code bridge | Verify one model task through changed-file readback, checks and PR result | Cloud MCP is OS-independent; access from Windows browser unverified | Cloud MCP is OS-independent; Mac client path unverified | **Tool exists; no accepted complete model task** | Paid model call and exact repo authorization |
| S2: email and other connected services | Browser bridge and selected MCP servers | Add scoped OAuth/native connectors or prove browser save/read/send with result receipts | Browser bridge unverified | Browser Gmail draft save/read unverified | **Not accepted** | Per-service authorization, extension readiness, paid model test |
| P1: Projects with reusable context | Owner-scoped project CRUD and chat grouping | Project instructions/files and verified context injection, deletion isolation | Web UI present, authenticated acceptance unverified | Same web UI status | **Grouping implementation only** | Schema lacks instructions/files; paid context test |
| M1: personal memory | Bounded manual CRUD; automatic memory agent off | Confirm CRUD and that a fresh chat uses only authorized memory | Web UI present, live result unknown | Same | **Unverified context use** | Paid fresh-chat check; autonomous extraction intentionally off |
| T1: schedules/background tasks | Owner-pinned schedule agent, schedule UI, engine and signed trigger | Repair HTTP 200 non-JSON start response, then prove timed fire, retry, recovery and completion notice | Hosted engine is OS-independent; not accepted | Same | **Failed live disposable Run now**: retries dead-lettered Oct 16 | Trigger/controller response contract; free Render sleep; recurring AI spend disallowed |
| K1: reusable skills/agents | General agents and skills code exists; single pinned schedule agent | Durable skill import, authorization, execution and user-facing lifecycle | `skills: false` | `skills: false` | **Not available** | Gated profile and storage/acceptance |
| R1: live web search and research | Tavily basic search, four results, 15-second timeout | Verify dated sources/citations; add source tracking for deeper research | Cloud feature; same status | Same | **Basic search configured; research unverified** | No no-cost model acceptance; narrow result set |
| I1: image create/edit | Default-off budget-gated Gemini device MCP image action and reference edit | Generate, edit, return/reopen image with settled cost | Cloud tool; same status | Same | **First paid attempt denied before provider**; no accepted image | Tool gate/provider acceptance and paid call |
| V1: speech and live voice | Speech-to-text UI, browser-local read-aloud | Audible STT/TTS check; duplex interruption/latency for live voice | Browser support/device permission unverified | Browser support/device permission unverified | **Read-aloud not audibly accepted; live voice absent** | Device/browser acceptance; live audio backend |
| X1: responsive long chat and cancellation | Context pruning, tokenizer init, client-disconnect abort; PR #68 bounds provider response read | Diagnose OOM, prove sustained long chats and actual incremental Claude streaming with safe accounting | Hosted route; same status | Same | **Offline bridge tests pass; live long-chat acceptance fails historically** | 512 MiB memory headroom; streaming/ledger redesign; paid E2E |
| X2: model routing and spend controls | Free Gemini default; manually selected Claude/OpenAI; monthly ledger | Verify selected model actually finishes representative task within budget on each route | Cloud feature; same status | Same | **Offline policy tests; live acceptance incomplete** | Paid calls prohibited for this project |

## Current acceptance sequence

1. Deploy and install the Windows scoped repository bridge, then validate its
   MCP route against a disposable repository. Finish C4 and test Mac separately.
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
The PR #68 gateway deploy disconnected both paired devices at 14:28 UTC;
`windows-work` reconnected with browser and scoped-file capabilities, while a
Mac reconnect was not observed in the checked logs. Gateway startup reported
code-worker status unavailable. These are connection observations, not action
acceptance.

The pinned upstream [code worker](https://github.com/LibreChat-AI/code-interpreter/blob/67d75d859aee891923c40cde1db073489d74a424/packages/code/README.md)
does not support native Windows; it documents WSL2 on a native Linux filesystem
as the local alternative. WSL2 is not installed on this Windows host. The new
Windows companion repository bridge deliberately exposes only a locally selected
checkout and named checks, with per-tool LibreChat approval. It does not provide
an arbitrary shell, persistent coding job, or a paid-model acceptance result.
