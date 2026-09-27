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
6. The Code API reports its worker health check passed.
7. No production service deploy was triggered by the development commit.

## Cost telemetry database access

The gateway cost dashboard should use `MISSION_AI_MONGO_URI` with a dedicated MongoDB Atlas user that has read-only access to the LibreChat database. Do not reuse the primary LibreChat application credential unless a temporary development exception is explicitly approved.

The dashboard reads only the `transactions` collection and returns aggregated usage/cost metadata. It never returns message content, API keys, or raw credentials.

## Free-plan behavior

The current development web services use Render Free instances. They may stop while idle and cold-start on the next request. This is acceptable for development validation but is not the final availability target. A deliberate hosting-plan decision is required before production acceptance of always-on local pairing or long-running cloud work.

## Promotion rule

Do not promote Mission AI to production until representative browser, Mac, code, research, file, image, routing, budget, recovery, and cost-comparison scenarios have been exercised successfully.
