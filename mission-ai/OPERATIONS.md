# Mission AI Operations

## Development services

- Gateway: `mission-ai-gateway-mckee`
- Separate test chat: `mission-ai-chat-test-mckee` (`MissionAIChatTest` application database)
- Code API: `mission-ai-code-api-mckee`
- Code queue store: `mission-ai-code-redis`
- Source branch: `mission-ai-v1`

Production LibreChat remains on `main`. The development services must not be used as a reason to merge or redeploy production before end-to-end acceptance is complete.

## Build validation

The gateway build runs syntax checks followed by the gateway and budget test suite during package installation. A development deploy is considered valid only when the test command exits successfully and Render reports the service live.

The Code API build is pinned by its wrapper script and must report successful worker startup before it is considered usable.

The separate test chat requires the full application build and API workspace typecheck, not just the gateway build. Use its [reviewed launcher and service settings](chat-test/README.md); automatic deployments remain off. Its completed no-paid browser checks are recorded in [acceptance evidence](ACCEPTANCE-EVIDENCE.md). Health alone does not establish login, accounting, or provider readiness.

## Service checks

For each development release, verify:

1. Render checked out the intended `mission-ai-v1` commit.
2. Gateway tests pass with zero failures.
3. Package audit reports no known vulnerabilities at build time.
4. The gateway binds the Render port.
5. The Code API starts both worker queues.
6. `GET /v1/health` on the Code API returns success; do not use the unsupported root path as the health probe.
7. The Code API reports its worker health check passed.
8. No production service deploy was triggered by the development commit.

## Cost telemetry database access

Use the two separate Atlas accounts required by [SECURE_SETUP.md](SECURE_SETUP.md):

- `MISSION_AI_MONGO_URI`: dedicated reader with only `read@test`, with `/test` explicit in the connection string. The existing LibreChat `transactions` collection is in `test`.
- `MISSION_AI_LEDGER_MONGO_URI`: different dedicated writer with only `readWrite@MissionAI`, with `/MissionAI` explicit in the connection string. Set `MISSION_AI_LEDGER_DB=MissionAI`.

Both accounts are restricted to cluster `LibreChat-McKee`. Do not rely on the runtime's compatibility URI fallback or combine these roles on one account for this deployment. Keep both connection strings private on the gateway.

The separate test chat instead uses its own `MONGO_URI`, user `mission_ai_chat_test`, and only `readWrite@MissionAIChatTest`. It receives neither gateway database credential. Preserve the original `My-Workstation-McKee` database login; do not reuse it or grant the gateway write access to `test`.

The native cost reader reads only `transactions`. The combined dashboard also uses the `MissionAI` ledger, including reservations and stale-reservation reconciliation, and returns aggregate cost metadata without message content or credentials. In snapshot mode, original LibreChat spending is settled history rather than an in-flight reservation. After an approved shared activation, the dashboard counts ledger events without adding the native mirror twice.

Keep `MISSION_AI_NATIVE_ENABLED=false` and `MISSION_AI_DELEGATION_ENABLED=false` on the gateway. Shared accounting is not activated. The original service remains outside a platform-wide atomic $175 cap. Activation, draining old callers, and a bounded paid native test require the separate [cutover procedure](NATIVE_BUDGET_CUTOVER.md) and approval; a prior standalone paid test does not satisfy these requirements.

For a read-only accounting observation, run `node accounting-preflight.js` from the gateway directory with its existing private environment. This deployment-scoped diagnostic pins the two account/database identities above, requires both paid flags to be exactly false, and reads native transactions and ledger state/events without reconciliation, index creation, or writes. It emits one bounded JSON summary with a provisional cutoff/digest, source commit, role observations, totals, reservation/block counts, and state/event agreement. It does not persist a plan or authorize activation. A failed or timed-out check reports `incomplete`; its zero exit status exists only so an operator startup prefix cannot prevent the normal server from starting.

If temporarily invoked through Render's start command, use `cd mission-ai/gateway && (node accounting-preflight.js; exec npm start)`, capture the safe receipt, then restore and verify the normal `cd mission-ai/gateway && npm start` command. Its deadline is 35 seconds plus at most 1.5 seconds for cleanup. Do not use the combined dashboard for a read-only audit because that path reconciles stale reservations. A provisional observation while the original service is running does not replace drain evidence, provider reconciliation, or a fresh approved cutover artifact.

## Free-plan behavior

The current development web services use Render Free instances. They may stop while idle and cold-start on the next request. This is acceptable for development validation but is not the final availability target. A deliberate hosting-plan decision is required before production acceptance of always-on local pairing or long-running cloud work.

September 28 test-chat samples were about 393–403 MiB initially and about 448.5 MiB after disabled-chat retries on a 512 MiB instance. These are light-use observations, not a capacity or concurrency guarantee. Headroom is limited; no paid instance upgrade has been approved by these checks.

## Development deploy recovery

Mission AI development uses fail-forward recovery and never uses production `main` as a recovery target.

1. If a Render build fails before promotion, leave the prior live development deploy serving traffic. Inspect the failing test/build log, fix the defect on `mission-ai-v1`, and deploy the reviewed development commit. The separate test chat uses a manual deployment while automatic deployments are off.
2. If a new development deploy becomes unhealthy after going live, identify the last known-good development commit/deploy, preserve its identifiers in the incident note, then either redeploy that development artifact or commit a fix/revert on `mission-ai-v1`.
3. Never recover development by writing to production `main`, the production `My-Workstation-McKee` service, production MongoDB data, or the protected backup branch.
4. After recovery, require the full development test suite, package audit, service health/startup, and device reconnect checks before considering the incident closed.

A failed build must not replace the last known-good live development artifact. This behavior is exercised during development and recorded in `mission-ai/ACCEPTANCE-EVIDENCE.md`.

## Promotion rule

Do not promote Mission AI to production until representative browser, Mac, code, research, file, image, routing, budget, recovery, and cost-comparison scenarios have been exercised successfully.


## Chrome control modes

Mission AI has two Chrome control layers on the personal Mac:

- Direct macOS Chrome automation is the resilient fallback for tab inventory, tab activation, opening a new tab, and closing explicitly selected tabs. It does not require the browser extension.
- The Chrome extension remains the page-level control layer for DOM-aware state, click, type, scroll, and navigation. Its transport uses Chrome Native Messaging to a locally installed Mission AI host process. The extension does not store the browser credential or open a localhost WebSocket itself; the native host reads the existing browser credential from macOS Keychain and relays only browser-tool messages over loopback to the companion.

Closing tabs is treated as destructive because a tab may contain unsaved work. The local companion rejects direct tab-close calls unless `confirm=true` is supplied. Do not auto-close tabs merely because they appear unused.

Temporary diagnostic tab-title/URL logging must remain disabled outside a short, deliberate development diagnostic window.
