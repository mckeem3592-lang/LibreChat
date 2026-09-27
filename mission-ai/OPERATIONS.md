# Mission AI Operations

## Development services

- Gateway: `mission-ai-gateway-mckee`
- Code API: `mission-ai-code-api-mckee`
- Code queue store: `mission-ai-code-redis`
- Source branch: `mission-ai-v1`

Production LibreChat remains on `main`. The development services must not be used as a reason to merge or redeploy production before end-to-end acceptance is complete.

## Build validation

The gateway build runs syntax checks followed by the gateway and budget test suite during package installation. A development deploy is considered valid only when the test command exits successfully and Render reports the service live.

The Code API build is pinned by its wrapper script and must report successful worker startup before it is considered usable.

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

Use a dedicated MongoDB Atlas credential scoped to exactly these database roles:

- `read` on the LibreChat database, for settled native transaction aggregation.
- `readWrite` on the separate `MissionAI` database, for delegated-usage reservations and settlements.

A single Atlas credential with those two scoped roles is sufficient. Set `MISSION_AI_MONGO_URI` to a connection string whose default database is LibreChat; the delegated ledger switches to `MissionAI` internally. `MISSION_AI_LEDGER_MONGO_URI` remains optional for deployments that prefer a separate ledger credential.

Do not reuse the primary LibreChat application credential unless a temporary development exception is explicitly approved. Do not grant account administration, user administration, schema management, or unrestricted write access to LibreChat.

The dashboard reads only the `transactions` collection and returns aggregated usage/cost metadata. It never returns message content, API keys, or raw credentials.

## Free-plan behavior

The current development web services use Render Free instances. They may stop while idle and cold-start on the next request. This is acceptable for development validation but is not the final availability target. A deliberate hosting-plan decision is required before production acceptance of always-on local pairing or long-running cloud work.

## Development deploy recovery

Mission AI development uses fail-forward recovery and never uses production `main` as a recovery target.

1. If a Render build fails before promotion, leave the prior live development deploy serving traffic. Inspect the failing test/build log, fix the defect on `mission-ai-v1`, and let auto-deploy validate the new commit.
2. If a new development deploy becomes unhealthy after going live, identify the last known-good development commit/deploy, preserve its identifiers in the incident note, then either redeploy that development artifact or commit a fix/revert on `mission-ai-v1`.
3. Never recover development by writing to production `main`, the production `My-Workstation-McKee` service, production MongoDB data, or the protected backup branch.
4. After recovery, require the full development test suite, package audit, service health/startup, and device reconnect checks before considering the incident closed.

A failed build must not replace the last known-good live development artifact. This behavior is exercised during development and recorded in `mission-ai/ACCEPTANCE-EVIDENCE.md`.

## Promotion rule

Do not promote Mission AI to production until representative browser, Mac, code, research, file, image, routing, budget, recovery, and cost-comparison scenarios have been exercised successfully.


## Chrome control modes

Mission AI has two Chrome control layers on the personal Mac:

- Direct macOS Chrome automation is the resilient fallback for tab inventory, tab activation, opening a new tab, and closing explicitly selected tabs. It does not require the browser extension.
- The Chrome extension remains the page-level control layer for DOM-aware state, click, type, scroll, and navigation.

Closing tabs is treated as destructive because a tab may contain unsaved work. The local companion rejects direct tab-close calls unless `confirm=true` is supplied. Do not auto-close tabs merely because they appear unused.

Temporary diagnostic tab-title/URL logging must remain disabled outside a short, deliberate development diagnostic window.
