# Mission AI Acceptance Evidence

This file records concrete development evidence. It is not a production approval; unchecked or blocked items remain blocking.

## 2026-09-27

### Development isolation
- All Mission AI writes in this workstream target `mission-ai-v1` and the Mission AI development services.
- Production `main`, production `My-Workstation-McKee`, production conversation data, and `backup/pre-mission-ai-2026-09-26` remain outside the development write path.

### Direct Chrome control
- The paired Mac companion successfully enumerated the live Chrome session through direct macOS Chrome automation without the extension.
- The diagnostic enumerated seven tabs, proving gateway -> paired Mac -> Chrome control.
- Temporary tab title/URL logging was disabled after the connectivity proof.
- Direct tab controls now use stable Chrome window/tab IDs; close also verifies the expected URL and requires `confirm=true`.
- Stable-ID behavior still requires a local companion update and end-to-end exercise before this row is fully accepted.

### Browser extension
- Browser Bridge 0.3.0 replaces the failed localhost/offscreen Chrome transport with Chrome Native Messaging.
- The extension has a deterministic ID and the native host manifest permits only that exact extension origin.
- The extension no longer fetches or stores the browser credential and has no localhost HTTP/WebSocket host permission.
- The local native host reads the browser credential from macOS Keychain and relays browser-tool messages to the companion over loopback.
- Page-level extension control is not yet accepted; the 0.3.0 native-host build still requires one local install/reload and real active-tab interaction exercise.

### Provider pricing
- OpenAI, Anthropic, and Google model IDs/pricing catalogs were reviewed against current provider documentation.
- Claude Sonnet 5 pricing is modeled as $2/MTok base input, $2.50/MTok 5-minute cache write, $4/MTok 1-hour cache write, $0.20/MTok cache read, and $10/MTok output.
- Anthropic usage normalization preserves the provider-reported 5-minute/1-hour cache-creation breakdown, with a conservative compatibility fallback when the breakdown is absent.

### CI and bad-deploy recovery
- A development build failed on an incorrect test fixture while the prior live development artifact remained serving.
- The fixture was corrected on `mission-ai-v1`.
- Fix-forward deploy `dep-dasqbubmmadc73e7vj10` passed 94/94 tests with zero failures and zero known npm audit vulnerabilities, then became live.
- This incident demonstrates build-failure isolation and fix-forward recovery; runtime rollback/fix-forward remains documented in OPERATIONS.

### Remaining external configuration
- OpenAI provider credential: configured.
- Anthropic provider credential: not configured.
- Google provider credential: not configured.
- Native/ledger Mongo cost telemetry credential: not configured.
- Full browser-extension page-control acceptance: pending.
- Measured real-use monthly cost comparison: pending representative Mission AI usage.


### Pinned code-worker boundary
- The deployed Mac worker is pinned to LibreChat code-interpreter commit `67d75d859aee891923c40cde1db073489d74a424`.
- Review of that exact commit confirms `--default-workspace` resolves to a private worker/deployment/workspace-specific directory beneath `~/.local/share/librechat/code/workspaces/`, rather than the user's home directory.
- The pinned workspace implementation confines file operations to the registered root, rejects symlink/root escapes, supports create-only writes with `overwrite:false`, and exact-match edits.
- Mission AI now explicitly starts the Mac worker with `native-srt` and the `restricted` command policy instead of relying on those upstream defaults.
- CI rejects a Mission AI worker installer that switches to `trusted-vm` or adds a broad `--worker-dir`.


### Code API dependency reproducibility
- Upstream Code API source remains pinned to `67d75d859aee891923c40cde1db073489d74a424`.
- The pinned upstream service has no service-level lockfile, so Mission AI now resolves a package lock first, verifies its SHA-256 against a checked-in approved fingerprint, and only then installs with `npm ci`.
- Approved dependency lock SHA-256: `2e21aa25df9bb912765cc1ade7d3a5a6cf0f63580bc55357edeafd56bb606838`.
- The first fingerprinted development build succeeded before the fingerprint was frozen.


### Direct-tab validator test recovery
- Direct-tab validation was extracted into a pure helper module so stable tab IDs, explicit close confirmation, expected-URL checks, and duplicate suppression are directly testable.
- The first test-only deploy exposed two fixture/assertion defects: a parser fixture used escaped delimiter text instead of real tab delimiters, and a legacy source-inspection test still expected the close-confirmation guard to live in `companion.js` after it had moved into the helper.
- The prior known-good development deploy remained live while the failing commits were rejected.
- Both test defects were corrected on `mission-ai-v1`; final fix-forward pass is required before this incident is closed.

## 2026-09-28

### Dedicated database and provider setup

- The existing LibreChat `transactions` collection is in database `test`.
- The dedicated reader authenticated with exactly `read@test`; the dedicated ledger user authenticated with exactly `readWrite@MissionAI`. Both users are restricted to cluster `LibreChat-McKee`.
- The gateway read 12 matching monthly native transactions. Its native monthly total and an independent aggregation agreed at $0.0656398; delegated and reserved totals were zero at the check.
- A ledger insert/read/update probe completed inside an aborted transaction. The abort and session close were confirmed, no probe document remained, and collection existence was unchanged.
- Anthropic and Gemini authenticated successfully using model-list requests. These checks did not perform paid generation. This supersedes the provider/database configuration items listed as pending on September 27.
- The disabled-delegation HTTP guard passed 8 regression tests and was deployed as commit `4832c956d3cdd2a15ae9e03f1095e4bef0f29a89`.
- Production `My-Workstation-McKee`, its original database login, and conversation data were not changed.

### Accounting acceptance scope

- The development accounting checks now exercise a real, isolated MongoDB replica set, including concurrent budget reservations, atomic rollback, retry/idempotency, period boundaries, and persistence across connections.
- Provider tests simulate network responses. No unit or integration check spends money or accesses Atlas credentials.
- Missing usage, uncertain provider outcomes, post-dispatch storage failures, and overruns must retain counted cost; overruns block new paid reservations rather than discarding the actual charge.
- See [accounting acceptance](acceptance/accounting.md) for repeatable commands, repair requirements, and unresolved promotion boundaries. At this initial local checkpoint, a live paid check and a shared reservation boundary with native LibreChat were outstanding. The subsequent standalone check is recorded below; live native activation remains outstanding.
- Local verification passed 165 unit tests and 28 isolated MongoDB integration tests, plus JavaScript/shell syntax checks. These include the durable single-use acceptance claim, tier verification, and long-context price boundaries.
- OpenAI Standard processing is explicit and verified from each response. Long-context prices are applied above 272,000 total input tokens; official model documentation was checked September 28.
- A dormant, approval-pinned acceptance runner can make one economy OpenAI request with a $0.05 reservation and 128-token output cap while general delegation remains false. Local tests did not call a paid provider; the separately approved live run is recorded below.

### Approved standalone OpenAI accounting check

- At 16:55:08 UTC, the runner reported `PASS_ACTUAL` for run `8efa5746-75c3-4d10-ba03-77b3f9e58ebd`, pinned to commit `da37595c104e22b4dd4694006f78175fc030f9cb`, on deployment `dep-dat9nlm0tbcc73aeui0g`.
- It made one `gpt-6-luna` request at Standard tier, without retry or fallback. Reported usage was 11 input tokens, 17 output tokens, and zero cache tokens. Actual cost was $0.0000096 against the approved $0.05 reservation.
- Independent arithmetic agreed: $0.0000011 input plus $0.0000085 output. The runner read back the settled event and matching balance change; no outstanding reservation or accounting block remained. The durable claim and event were retained.
- Normal startup was restored and verified in deployment `dep-dat9o7p7lnhs73c7f1ig`. General delegation stayed disabled. This validates only the standalone OpenAI economy path, not all-provider inference, provider-invoice reconciliation, or native LibreChat accounting. Do not repeat the run without new authorization.

### Separate managed test chat: no-paid acceptance

- The test service `mission-ai-chat-test-mckee` was created in the user-confirmed My Workspace, using a separate `MissionAIChatTest` database and `mission_ai_chat_test` account with only `readWrite@MissionAIChatTest`, restricted to `LibreChat-McKee`. No original-service environment group was reused. Automatic deployments remain off.
- The private owner bootstrap returned `created`; owner login succeeded. Bootstrap email/password values were subsequently cleared and its enable flag set false. The account remained usable after deployment and reload. Public registration remained disabled.
- Final verified commit: [`8ab89e169e344671e78804b899cc508ed8d5befe`](https://github.com/mckeem3592-lang/LibreChat/commit/8ab89e169e344671e78804b899cc508ed8d5befe). [CI run 36465293664](https://github.com/mckeem3592-lang/LibreChat/actions/runs/36465293664) passed the full application build, API workspace typecheck, existing chat-loading Lighthouse audit, 257 main unit tests, 55 accounting/adapter integration tests, and the opt-in MongoDB bootstrap check. The separate bootstrap invocation repeats 40 unit cases already included in the main count.
- Test deployment `dep-datb5b0u01pc73dunqb0` went live at 18:36:47 UTC; gateway deployment `dep-datb313rjlhs73bejk2g` used the same commit. Independent review matched published content and modes to the reviewed files. Gateway health returned 200 and native models returned 404 `native_bridge_disabled`.
- All 12 public checks passed on the final deployment: health/readiness/login returned 200; anonymous user/model routes required authentication; signup, password reset, direct-provider, file, and audio routes were denied.
- Signed-in acceptance was recorded at 18:39:36 UTC. The owner session survived deployments and reloads. Economy, Primary, and Reasoning presets were available; file and microphone controls were disabled. A normal Economy request passed managed admission and ended in the expected unavailable-upstream error while native admission was off. It did not return the previous managed-request or configuration denial.
- The saved conversation retained one user prompt and its failed response after reload. Two safe regenerations ended in the same error, restored controls, and left no generating indicator. Disabled responses finished before Stop became available, so cancellation of a real provider request was not exercised.
- `MISSION_AI_NATIVE_ENABLED=false` and `MISSION_AI_DELEGATION_ENABLED=false` remained explicit; shared accounting was not activated. No new paid request was made during these browser checks. Request-level gateway metrics/logs were unavailable, so exact per-attempt gateway receipts are not claimed. A disabled route returns before native-token verification; these checks alone do not establish live token acceptance or complete bypass/egress coverage.
- The original service remained on `main`, deployment `dep-dasksdgae00c73b7mglg`, commit `b31617a816f5fd14c9346b57f3e6252e188984e8`, with configuration timestamp `2026-09-27T17:14:56.55896Z`. Its login, database contents, provider configuration, and conversations were preserved.

The bounded no-paid test setup is accepted. Paid native use, old-caller drain and historical reconciliation, shared activation, complete route/egress acceptance, and the broader platform matrix remain pending. There is no platform-wide atomic $175 ceiling claim for the running original service, and no production promotion occurred.
