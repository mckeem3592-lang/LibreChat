# Separate Mission AI test chat

This directory prepares a **new** LibreChat test service from `mission-ai-v1`. It does not change `My-Workstation-McKee`, its login, its database, or the existing gateway's paid settings. Provisioning the test service does not activate shared accounting or authorize a paid request. Both paid gateway flags remain false until the separately approved steps in [NATIVE_BUDGET_CUTOVER.md](../NATIVE_BUDGET_CUTOVER.md) are complete.

## Render service settings

Use repository `mckeem3592-lang/LibreChat`, branch `mission-ai-v1`, the exact reviewed commit containing these files, and a **new** Node web service named `mission-ai-chat-test-mckee` (or the user-approved available name). Select the confirmed Render workspace; do not infer it from an old selection. Leave Root Directory empty: this app needs the complete monorepo. Use Node `24.16.0`, matching `.nvmrc`. Keep automatic deployments off during acceptance.

| Setting | Value |
| --- | --- |
| Build command | `npm ci --include=dev --no-audit --no-fund && npm run frontend` |
| Start command | `bash mission-ai/chat-test/start.sh` |
| Health check | `/health` |
| Host/port | Launcher sets `HOST=0.0.0.0`; uses Render's `PORT`, defaulting to `10000` |
| Config | Launcher selects the repository's `mission-ai/config/librechat.shared-budget.yaml` |

The root `frontend` script builds data-provider, data-schemas, API, client package, and the actual client. Installing only `mission-ai/gateway` cannot build this application. Do not deploy a public upstream Docker image or the gateway-only service in its place. The stock Alpine Dockerfile is not this launch procedure and does not provide Bash by default.

The startup check is `bash mission-ai/chat-test/start.sh --check`. It validates settings without MongoDB or provider calls. `/health` only proves that the web process is responding; it does not prove login, gateway authorization, budget activation, or accounting acceptance.

## Minimum private environment

Enter secrets privately in this new service's Render Environment screen. Do not copy an original-service environment group, paste secrets in chat, or store a populated `.env` in this checkout. The launcher rejects a nonempty root `.env` and known direct-provider/upstream settings; this includes `user_provided` sentinels.

| Variable | Required value |
| --- | --- |
| `NODE_VERSION` | `24.16.0` |
| `MISSION_AI_MANAGED_CHAT` | Exactly `true`; required server-side managed API guard |
| `MONGO_URI` | Dedicated Atlas `mongodb+srv` URI, username **`mission_ai_chat_test`**, explicit database **`/MissionAIChatTest`**, and that user's private password |
| `MISSION_AI_GATEWAY_URL` | Exactly `https://mission-ai-gateway-mckee.onrender.com` |
| `MISSION_AI_NATIVE_TOKEN` | New random token, at least 32 characters, privately shared only with this gateway's native-token setting; different from gateway device/tool tokens and every application secret |
| `DOMAIN_CLIENT` | This **new** service's exact HTTPS origin, without a trailing slash |
| `DOMAIN_SERVER` | The same exact HTTPS origin |
| `JWT_SECRET` | New persistent random 32-byte value encoded as 64 hex characters |
| `JWT_REFRESH_SECRET` | Different new persistent random 32-byte value encoded as 64 hex characters |
| `CREDS_KEY` | Different new persistent random 32-byte value encoded as 64 hex characters |
| `CREDS_IV` | New persistent random 16-byte value encoded as 32 hex characters |

Atlas must grant `mission_ai_chat_test` **readWrite on MissionAIChatTest only**, restricted to `LibreChat-McKee`. The URI parser checks its database and username, not the user's real Atlas permissions or cluster identity: verify both in Atlas. Supported query options are `retryWrites=true`, `w=majority`, `appName`, `authSource=admin`, and `tls=true`. Other options, missing database, another database/user, and TLS downgrades fail startup without displaying the URI. The existing reader and `MissionAI` writer credentials do not belong on this service.

The launcher fixes `ENDPOINTS=custom`, registration/social login/password reset/unverified login/search/Redis/debug flags and `TITLE_CONVO` to false, and `ALLOW_EMAIL_LOGIN=true`, `SESSION_COOKIE_SECURE=true`, `NODE_ENV=production`, `TRUST_PROXY=1`. Explicit conflicting values fail startup. No generic `SESSION_SECRET`, SMTP, social-login credential, provider API key, device token, tool token, or ledger URI is required. Persistent JWT/credential values are necessary because Render's filesystem is ephemeral; do not rely on `.env.temp` fallback generation. The managed API guard is mandatory; never remove its flag to get an unsupported route working.

The native token's difference from gateway-only device/tool tokens must be checked privately at gateway configuration time; this application intentionally never receives those tokens. The gateway also rejects their reuse. Do not set gateway enablement/budget variables on the chat service: they govern the separate gateway and are rejected here.

Deployment plugin hooks are fixed off. Each startup creates private empty plugin, skill, and plugin-data directories, so neither the repository's legacy extensions nor operator-supplied extension directories are loaded. Nonempty `DEPLOYMENT_PLUGINS_DIR`, `DEPLOYMENT_SKILLS_DIR`, or `DEPLOYMENT_PLUGIN_DATA_DIR` overrides are rejected; `DEPLOYMENT_PLUGIN_HOOKS=true` also fails startup.

## Private first account

The initial database is empty, and **public registration stays off**. A normal Render web service still has a public URL: closed registration and required login make access account-restricted, not network-private. Do not label it private-network hosting.

Before login testing, use the reviewed one-time `bootstrap.cjs` entry point to provision only the intended owner's verified local account. Privately enter `MISSION_AI_OWNER_EMAIL`, a new strong `MISSION_AI_OWNER_PASSWORD`, and `MISSION_AI_BOOTSTRAP_OWNER=true` on this new service. The launcher runs bootstrap only when that flag is explicitly true, after validating the dedicated database and closed-registration settings. The TypeScript bootstrap must verify an empty test users collection before first creation, hash before persistence, and create the verified local owner as ADMIN without temporary-user expiry. Review its focused tests and restart/idempotency behavior before deployment. This does not require public registration or a Render shell.

After the safe creation receipt and first owner login, remove both owner-credential variables and the bootstrap flag from Render and redeploy. The launcher unsets them before starting the web process even on the initial boot. Retain the persistent JWT/encryption values. Never put a bootstrap password in shell arguments, the launcher, deployment logs, or source; never expose it in chat. Existing-account handling must not replace passwords or create another user on restart.

The stock `config/create-user.js` is **not** the approved password bootstrap: it echoes its password prompt, and a blank password generates and prints a `Math.random` password. Do not feed a password to that command unattended or as an argument. The separate bootstrap avoids that registration helper. Although the upstream registration helper passes registration input to the central logger in some error paths, that logger redacts password fields; this review does not establish a password leak through those structured logs.

The upstream invitation flow is not enabled by this managed profile: although `checkInviteUser` and `validateRegistration` normally permit an email-bound invite with public registration off, the managed API guard also denies the registration route. Enabling invitations would require a separately reviewed guard change, email configuration, and approval to send that particular invitation. Never temporarily open public registration on an empty public instance: the first unscoped registered account becomes ADMIN. Confirm ordinary signup stays denied and only the intended account exists after bootstrap. Enable MFA after the owner's first sign-in; the managed guard preserves the authenticated upstream enrollment and recovery-code routes.

## Test boundary and promotion evidence

- Begin with an empty app database. Do not import saved roles, credentials, agents, tools, schedules, plugins, or tenant overrides from production. Approved history migration is separate work.
- This launcher validates deployment inputs and requires the separately reviewed managed API guard. It is not a network-egress guard, and the YAML's hidden controls do not secure every API. Verify the guard's denied provider/tool/RAG/speech/image endpoints and the egress/route restrictions in the cutover procedure before enabling paid work.
- Confirm the deployed commit, exact service identity, application origins, health response, closed signup, authenticated owner login, and only the managed endpoint/model list. Gateway-disabled errors are the expected safe result until activation and native enablement are approved.
- Keep `MISSION_AI_NATIVE_ENABLED=false` and `MISSION_AI_DELEGATION_ENABLED=false` **on the gateway**. Do not run a provider acceptance test, shared-ledger import, or production traffic cutover while preparing this service.
- Validate actual LibreChat request shaping, restored sessions, denied overrides, and gateway accounting before making any claim that native spending is fully controlled. Gateway unit/fake-provider tests are not deployed application acceptance.

## Capacity and rollback

Render currently lists Free web services at 512 MB RAM and 0.1 CPU. They sleep after 15 minutes without traffic and lack shell/SSH access, one-off jobs, and persistent disks. That affects first-account provisioning and restart behavior. See [Render compute plans](https://render.com/docs/compute-plans) and [Free service limits](https://render.com/docs/free).

A full LibreChat build/runtime is substantially larger than the gateway. The repository's frontend build allows an 8192 MB V8 heap, which is a ceiling, not a measured requirement; it does not show that the runtime fits 512 MB. No test-service memory measurement has been performed. Treat a Free deployment as a capacity experiment, observe startup/RSS/OOM and cold starts, and ask before any paid plan upgrade. A small paid plan with the same 512 MB would not solve a memory shortage by itself. Build capacity and runtime instance capacity must both be checked.

If preparation fails, stop or roll back only this new test service. Preserve its database/account records and investigation evidence. Do not change the original service, switch the test application to its database/login, remove reservations, or enable direct-provider credentials as a workaround.
