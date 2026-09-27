# Mission AI Acceptance Matrix

Mission AI is not production-ready until every required scenario below passes on the development branch and development services.

## Cloud and provider layer

- Provider-independent routing selects the configured OpenAI, Anthropic, or Google role without exposing credentials.
- General chat defaults to OpenAI primary.
- Coding tasks prefer Anthropic and fall back safely.
- Research and image tasks prefer Google and fall back only where the capability is compatible.
- Invalid spend data fails closed.
- Monthly budget modes change at $100, $125, and $175 as designed.
- The hard limit prevents additional paid model routing at or above $175.
- Provider outages produce bounded fallback rather than retry storms.

## Usage and cost

- Settled prompt and completion debits reconcile to the monthly USD total.
- Month boundaries use America/Denver correctly across daylight-saving changes.
- Dashboard totals match the underlying settled transaction aggregation.
- A monthly cost comparison can be exported after representative usage.

## Mac companion

- Pairing is one-time and time-limited.
- Device credentials are stored in macOS Keychain.
- The Mac opens no public inbound port.
- Gateway reconnects after sleep, Wi-Fi change, and service restart.
- Accessibility-dependent input fails clearly when permission is absent.
- Screen capture fails clearly when Screen Recording permission is absent.
- App launching is restricted to the configured allowlist.
- Local browser bridge listens on loopback only.

## Browser control

- Uses the user's existing Chrome profile and session.
- Direct Mac-backed controls can list, activate, open, and explicitly confirmed-close Chrome tabs without the extension.
- Tab close fails unless an explicit confirmation flag is supplied.
- The Chrome extension can read active-tab state, click, type, scroll, and navigate a URL for page-level interaction.
- Password fields are never filled.
- Browser page content cannot authorize new native capabilities.
- Direct tab controls reconnect with the Mac companion after sleep, Wi-Fi change, and service restart.
- Extension reconnects after Chrome restart and Mac sleep before page-level browser acceptance is considered complete.

## Code, files, documents, images, and research

- Attached code environment can create, edit, test, and return project artifacts.
- File/document tasks preserve originals unless a replacement is explicitly intended.
- Web research returns sourced results.
- Image workflows use the configured image provider.
- Background tasks that do not require the Mac can complete while the Mac is offline.

## Safety and operations

- Audit records contain action metadata but not passwords, API keys, tokens, or typed content.
- Destructive operations require the intended confirmation boundary.
- Unknown tools fail closed.
- Production LibreChat, MongoDB conversations, and the backup branch remain unchanged during staging.
- Development services pass CI and health checks for the promoted commit, including the Code API's supported `/v1/health` route.
- Recovery from a bad development deploy is documented and tested.

## Representative user workflows

Before promotion, exercise at least one end-to-end scenario for each: browser control, Mac control, software development, spreadsheet/document handling, web research, image work, scheduled work, provider fallback, budget enforcement, and recovery after device disconnect.

Production promotion requires all required rows to be recorded as passing, plus a measured Mission AI cost comparison from real usage.
