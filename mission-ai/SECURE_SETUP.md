# Mission AI Secure Runtime Setup

Do not paste secrets into chat, source code, commits, or screenshots.

## Owner controls in the separate chat

The sidebar's Mission AI controls show ledger spending and run only basic free
search. The authenticated owner reaches exact `/api/mission-ai/capabilities`,
`/api/mission-ai/status`, and `/api/mission-ai/search` routes. Other users, extra
routes, and cross-origin search submissions are denied. Gateway credentials stay
on the server. No paid model is called to open or refresh this panel.

The startup wrapper retains only the owner email as
`MISSION_AI_CONTROL_OWNER_EMAIL` before discarding bootstrap credentials. After
one-time bootstrap is removed, keep this email configured privately; an absent
email denies controls. The gateway's native token protects the separate
`/native/control` status/search routes even while paid native chat is disabled.
These routes do not expose paid, image, shell, or browser execution operations.
All paid gates remain off during setup. Original chat remains outside this cap.

## MongoDB Atlas

Create two dedicated users rather than reusing LibreChat's primary application user.

### 1. Mission AI dashboard reader

Environment variable:

`MISSION_AI_MONGO_URI`

Access:

- Read-only access to the existing LibreChat database.
- The gateway currently needs the `transactions` collection for cost telemetry.
- Do not grant database write privileges.

### 2. Mission AI delegated-usage ledger

Environment variable:

`MISSION_AI_LEDGER_MONGO_URI`

Access:

- Read/write access only to a separate `MissionAI` database.
- The gateway uses:
  - `budget_state`
  - `budget_control` (shared accounting activation and transaction fence)
  - `delegated_usage`
  - `paid_acceptance_claims` (durable, explicitly approved acceptance runs only)
- Do not grant write access to the LibreChat application database.

Optional:

`MISSION_AI_LEDGER_DB=MissionAI`

## Provider credentials

Set provider keys only as Render secrets on the Mission AI gateway development
service. Never put them in GitHub or `.env` files committed to the repo.

- OpenAI: `OPENAI_API_KEY`
- Anthropic: `ANTHROPIC_API_KEY`
- Google Gemini: `GEMINI_API_KEY` (preferred); `GOOGLE_KEY` remains supported
  for LibreChat compatibility.

Keep paid delegation disabled until database accounting is connected and verified:

`MISSION_AI_DELEGATION_ENABLED=false`

After provider readiness, cost telemetry, and ledger readiness all pass, enable
paid delegation explicitly:

`MISSION_AI_DELEGATION_ENABLED=true`

General enablement also requires the [accounting acceptance checks](acceptance/accounting.md).
The native LibreChat spend snapshot does not reserve native in-flight requests;
do not interpret the delegated ledger's cap as an atomic limit across both services.
Keep delegation disabled until that boundary is resolved and enablement is approved.

The development branch now contains an opt-in native Chat Completions bridge and
shared ledger. It remains inactive by default. Follow the reviewed
[native cutover procedure](NATIVE_BUDGET_CUTOVER.md) before using it: a dedicated
`MISSION_AI_NATIVE_TOKEN`, an exact `MISSION_AI_NATIVE_MODELS` allowlist,
`MISSION_AI_NATIVE_ENABLED=true`, and durable shared-ledger activation are all
required. Deploying the code alone does not activate native requests or establish
a platform-wide cap. Keep both paid gates false during preparation.

The production text bridge is pinned to Anthropic `claude-sonnet-5-5`, with
standard-only capacity and no retry/fallback. The managed model client also has
`maxRetries: 0`; only text is supported by the compatible adapter.

The native `/native/anthropic/v1/messages` transport preserves signed thinking
blocks, custom tool calls and paired text tool results. It uses the same native
token, paid-enable gate, atomic ledger, fixed model and output limits. Provider
server tools, fallback fields, forced tool loops and alternate capacity tiers
are rejected. Buffered JSON/SSE is delivered only after durable accounting;
unverified usage retains the conservative reserved charge. The managed chat
configuration still uses the restricted text adapter: deploying the native
transport does not enable chat tools or authorize a local action. The actual
Anthropic SDK is tested with synthetic responses and no provider calls.

The separate chat now has an opt-in native tool configuration. Its default is
`MISSION_AI_MANAGED_TOOLS=false`, using the existing text configuration. The
`true` path selects only `librechat.tools-budget.yaml` and requires the approved
`MISSION_AI_CONTROL_OWNER_EMAIL` plus a separate `MISSION_AI_TOOL_TOKEN`.
Activation needs explicit owner approval for the browser/Mac tool access; a
spending-panel approval alone does not grant that broader scope. Keep paid gates
off while configuring. No direct provider/search credentials belong on the chat.

Native tool mode pins Sonnet 5.5, the gateway's Messages endpoint, one fixed MCP
server, zero client retries, low effort, and eight graph steps. Owner checks run
after authentication for both chat and MCP metadata. Alternate MCP servers,
OAuth/credential APIs, endpoint changes, retry overrides and unlisted APIs are
denied. Every MCP action also asks for chat approval, and local mutations retain
the independent Terminal preview/literal-`y` checkpoint. Memory, schedules,
coding workspaces and file features remain disabled pending their integration;
this configuration is not final product acceptance.

Keep `MISSION_AI_SEARCH_ENABLED=false` until search acceptance. The gateway's
only search path is Tavily basic, with no model answer or alternate provider.
It checks current account/key limits and requires a verified PAYG-off timestamp
(`MISSION_AI_TAVILY_PAYG_OFF_VERIFIED_AT`) bound to the saved key's SHA-256
(`MISSION_AI_TAVILY_KEY_SHA256`). The check expires after 24 hours and at the
UTC month boundary. A null API PAYG limit alone is not accepted as proof.
Free-credit holds live in `MissionAI.free_search_state` and remain blocked after
crashes or ambiguous usage. These credit holds are separate from the USD ledger.
Do not clear them or substitute a paid plan to pass a check.

## Mission AI budget

- Target: $100/month
- Economy mode: $125/month
- Hard stop: $175/month
- Month boundary: America/Denver

The hard-stop path uses both native LibreChat transactions and delegated Mission
AI spend. Delegated requests reserve a conservative worst-case amount before
the provider request begins.

## Pairing the personal Mac

Pairing is separate from provider/database setup. The Mac bootstrap obtains and
stores device credentials in macOS Keychain; it does not require provider keys
on the Mac.

Run the bootstrap only on the personal Mac:

```bash
curl is intentionally not used as a remote install mechanism.
Clone/update the repository and run mission-ai/bootstrap-macos.sh from the
checked-out mission-ai-v1 branch.
```

The final local acceptance command is:

```bash
zsh ~/.local/share/mission-ai/source/mission-ai/acceptance/check-macos.sh
```

## Production boundary

Do not merge `mission-ai-v1` to `main` and do not alter the production
`My-Workstation-McKee` Render service until the acceptance matrix is complete
and the user explicitly approves promotion.

## Bounded native vision transport

The native Sonnet route accepts base64 JPEG, PNG, GIF and WebP images in user messages and paired tool results. External URL/file sources and assistant image blocks are refused. The existing one-megabyte request ceiling and a twenty-image ceiling remain in force. Each image adds a conservative 4,784 visual-token allowance to the existing byte/framing reservation, using the highest applicable input/cache price and long-context tier. Provider-reported usage settles the actual cost; ambiguous responses retain the reservation. This support does not enable paid requests, grant device permissions, or constitute live image-workflow acceptance.

Reference: https://platform.claude.com/docs/en/build-with-claude/vision
