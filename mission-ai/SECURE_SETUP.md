# Mission AI Secure Runtime Setup

Do not paste secrets into chat, source code, commits, or screenshots.

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
