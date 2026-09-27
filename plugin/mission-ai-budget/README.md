# Mission AI budget plugin

This deployment plugin blocks or constrains Agent runs based on settled monthly LibreChat transaction spend.

## Required LibreChat settings

Agent command hooks are disabled by default. A LibreChat deployment using this plugin must set:

- `DEPLOYMENT_PLUGIN_HOOKS=true`
- `MONGO_URI`
- `MISSION_AI_BUDGET_TARGET_USD=100`
- `MISSION_AI_BUDGET_ECONOMY_USD=125`
- `MISSION_AI_BUDGET_HARD_USD=175`
- `MISSION_AI_BUDGET_TIMEZONE=America/Denver`

The hook manifest allowlists only the environment variables it needs. Secrets must stay in deployment-managed environment variables and must not be committed to the repository.

## Policy

- Below $100: normal routing.
- $100 through $124.99: budget notice.
- $125 through $174.99: economy routing guidance.
- $175 and above: fail closed and block continuation.
- If monthly spend cannot be verified: fail closed.

The month boundary helper has explicit tests for America/Denver standard time and daylight time.

## Rollout

Do not enable this plugin directly on the production LibreChat service first. Validate startup diagnostics, a normal request, economy-mode behavior, the hard-stop path, and rollback on an isolated LibreChat deployment before promoting the same configuration to production.
