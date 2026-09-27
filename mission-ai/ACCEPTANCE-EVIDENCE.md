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
- Browser Bridge 0.2.1 includes an offscreen transport, handshake retries, and phase-specific pairing diagnostics.
- Page-level extension control is not yet accepted; the revised extension still requires a local reload and connection exercise.

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
