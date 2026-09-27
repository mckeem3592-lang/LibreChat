# Mission AI

Mission AI extends this LibreChat deployment without unnecessary core forks.

## Architecture

- **LibreChat on Render** remains the primary chat UI and agent platform.
- **Mission AI Gateway** is a separate Render development service that handles routing and narrowly scoped tool calls.
- **Mission AI Code API** is a separate Render development service for attached code sessions and worker coordination.
- **Mission AI Companion** runs on macOS and maintains an outbound device connection.
- **Mission AI Chrome extension** works with the user's existing Chrome profile and active tab through the local companion.
- **Mission AI budget plugin** tracks settled LibreChat transaction spend against the configured monthly policy.

No inbound public port is opened on the Mac.

## Development isolation

All Mission AI development work belongs on `mission-ai-v1` and the separate Mission AI Render services. Production LibreChat stays on `main` until end-to-end acceptance passes.

The preserved baseline branch must remain available for rollback.

## Current development services

- `mission-ai-gateway-mckee`
- `mission-ai-code-api-mckee`
- `mission-ai-code-redis`

Both web services currently use Render Free compute and may stop while idle. That is acceptable for development, but final always-on availability requires a deliberate hosting-plan decision.

## Implemented foundation

- Provider-independent route selection with explicit model overrides.
- OpenAI, Anthropic, and Google provider catalog scaffolding.
- $100 target, $125 economy threshold, and $175 hard monthly budget policy.
- Read-only monthly settled-spend reporting helpers.
- Development build checks and automated tests.
- One-time Mac pairing flow.
- Keychain-backed Mac companion credentials.
- Outbound-only Mac device connection.
- Local-loopback Chrome bridge.
- Attached Code API and Mac code-worker enrollment.
- Durable agent checkpointer configuration.
- Background-task and scheduled-work configuration fragments.

## Remaining acceptance work

1. Complete provider authorization for every enabled provider and verify readiness without exposing credentials.
2. Run the Mac bootstrap on the user's machine and approve the required macOS permissions.
3. Load the Chrome extension and run real active-tab interaction tests.
4. Exercise attached code sessions from LibreChat against the Mac worker.
5. Expose settled-spend reporting through the final dashboard experience.
6. Verify provider fallback, recovery after restart/sleep, and representative end-to-end workflows.
7. Produce a measured real-use cost comparison before any subscription decision.
8. Promote to production only after the acceptance checks pass.

See `OPERATIONS.md` for deployment validation notes.
