# Mission AI Secure Runtime Setup

Do not paste secrets into chat, source code, commits, or screenshots.

## One-request accounting acceptance while paid gates are off

For the subsequent owner-approved chat/tool acceptance, a temporary native window
can be configured with `MISSION_AI_ACCEPTANCE_START`, `MISSION_AI_ACCEPTANCE_END`,
`MISSION_AI_ACCEPTANCE_BASELINE_USD`, and `MISSION_AI_ACCEPTANCE_ALLOWANCE_USD`.
It requires the ordinary native gate to remain false, expires within 30 minutes,
cannot cross a Denver accounting-month boundary, and accepts at most $0.10 of
additional spending. Native reservations use the lower of the normal shared cap
and baseline plus allowance, so concurrent requests cannot exceed the test ceiling.
Missing, malformed, expired or oversized settings deny the temporary path.
Remove these settings after testing; this window is not general paid activation.

`gateway/paid-acceptance.js` supports an explicitly approved Anthropic run pinned
to `claude-sonnet-5-5`, the deployed source SHA, the model's verified pricing date,
and a fresh UUID. Both native chat and delegation must remain disabled. It reserves
$0.05 before sending one standard-only request containing only `Reply only with
OK.`, with at most 128 output tokens and a 20-second provider timeout. There are no
tools, history, provider fallbacks or retries. The durable claim prevents replay,
including after a failure or process restart. Verified usage settles the actual
charge; uncertain billing retains the conservative charge. This direct provider
accounting test does not establish native chat or computer-tool readiness and
does not authorize enabling any paid gate. Reusing private gateway credentials
in a local operator requires explicit approval; never print or commit them.

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

The native Sonnet route accepts base64 JPEG, PNG, GIF and WebP images in user messages and paired tool results. External URL/file sources and assistant image blocks are refused. Text and request metadata remain limited to one megabyte; validated image payloads have a twelve-megabyte total request ceiling, a four-megabyte base64 ceiling per image and a twenty-image ceiling. Each image adds a conservative 4,784 visual-token allowance to the text/metadata byte and framing reservation; validated image bytes are excluded from text-token estimates, using the highest applicable input/cache price and long-context tier. Provider-reported usage settles the actual cost; ambiguous responses retain the reservation. This support does not enable paid requests, grant device permissions, or constitute live image-workflow acceptance.

Reference: https://platform.claude.com/docs/en/build-with-claude/vision

## Prepared attached coding workspace

The default-off managed-tools configuration uses the existing Free Code API and the existing Mac worker, never an implicit cloud sandbox. Coding requests require one explicitly selected workspace on `attached-workers`, `codeEnvironmentMode=attached` and `codeApprovalMode=ask`. Only owner-authenticated environment discovery/status routes are admitted; enrollment, settings edits and environment deletion are denied. Every chat tool asks for approval, and the installed worker separately requires its exact terminal preview and a human literal `y` for each mutation.

Before enabling this broader scope, the separate test service requires the existing `MISSION_AI_CODE_BRIDGE_ADMIN_TOKEN`, `CODEAPI_AUTH_PROVIDER=librechat-jwt`, `CODEAPI_JWT_PRIVATE_KEY_BASE64`, `CODEAPI_JWT_ALGORITHM` (EdDSA or RS256), `CODEAPI_JWT_KID`, `CODEAPI_JWT_ISSUER`, `CODEAPI_JWT_AUDIENCE`, and `CODEAPI_JWT_SINGLE_TENANT_ID`. Startup verifies the signing key and refuses API-key fallback mode. These existing private settings must match the Code API deployment; no new keys or services should be created to bypass a failed match. The owner-panel approval alone does not authorize this broader tool scope. Live coding acceptance remains pending worker reconnection and manual approval verification; paid model requests remain off.

## Screenshot coordinates and bounded capture

The companion captures only the primary display, compresses each JPEG to at most 192 KiB, and returns its screenshot ID, image dimensions and logical display frame. Mac clicks require that ID and coordinates measured in the resized image. The companion shows both image and converted screen coordinates in the local approval preview, then checks the display frame and screenshot age again after the owner's literal `y`. Changed displays, unknown/expired screenshots, supplied screen-coordinate overrides and out-of-bounds points are denied. Mutations invalidate earlier screenshots. A fresh capture is required before a subsequent click. The installed companion must be updated before this protocol is activated; its Screen Recording permission and live point accuracy still need owner-assisted acceptance.

## Prepared projects and inline memory

The default-off managed-tools configuration reuses LibreChat projects and memory in the separate test database. Project context IDs are validated and checked against the authenticated owner before endpoint construction can send a paid request. Project and personal-memory management routes remain authenticated and owner-only, with bounded payloads; other agent partitions and route aliases are refused. Inline memory uses the existing capped Sonnet turn and its approval policy. Dedicated memory-agent personalization stays disabled, so this configuration does not create a second AI call to summarize or save memory. The memory pool is bounded to 2,000 tokens and each entry to 10,000 characters. Existing opt-out and deletion controls remain available. Live persistence and UI acceptance remain pending owner activation.

Cloud scheduling is not enabled in this batch. The current repository is public with default branch `main`; GitHub scheduled workflows require the default branch, so placing a workflow only on `mission-ai-v1` cannot provide an active wake-up. Preserve the original deployment: a separately approved small public wake-up repository is the proposed free runner option. Without an external wake-up, Free Render scheduling is limited to times the service is awake. No repository, cron service or paid runtime has been created for this proposal.

Sources: https://docs.github.com/en/billing/concepts/product-billing/github-actions and https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule

Native chat cost attribution uses a server-derived project header after project ownership validation. The gateway records the bounded project identifier in private accounting metadata and removes it from upstream provider requests. No project context is automatically added to prompts for accounting. Live project cost acceptance remains pending.

## Inline coding workspace selection

When the owner enables Run Code on the managed MissionAI model, the composer requires an explicit selection of the existing Mac's primary workspace. The ephemeral agent loader binds that same selection to the attached Code API and conversation scope. Text-only turns receive no workspace binding. Missing selections, cloud opt-outs, different workspaces, other owners and relaxed approval modes fail before model execution. Named file/command tools do not require dynamic workspace provisioning, which remains refused by the local approval guard. Paid requests remain off during this configuration and acceptance.
