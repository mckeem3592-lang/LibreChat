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
