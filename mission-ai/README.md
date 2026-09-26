# Mission AI

Mission AI extends this LibreChat deployment without forking core behavior unnecessarily.

## Architecture

- **LibreChat on Render** remains the primary chat UI and provider/agent platform.
- **LibreChat attached code environments** handle project files, shell commands, Git workspaces, and background code execution on the user's Mac through the outbound `@librechat/code` worker architecture.
- **Mission AI Gateway** runs in the cloud and exposes narrowly scoped tool calls. It never accepts unauthenticated device traffic.
- **Mission AI Companion** runs on macOS, creates an outbound WebSocket to the gateway, and exposes only allowlisted native actions.
- **Mission AI Chrome extension** controls the user's existing Chrome profile and active tab. It connects only to the loopback companion.

No inbound public port is opened on the Mac.

## Security model

1. Cloud-to-device tool calls require `MISSION_AI_TOOL_TOKEN`.
2. The Mac-to-cloud device connection requires `MISSION_AI_DEVICE_TOKEN`.
3. Chrome-to-companion traffic is loopback-only and requires `MISSION_AI_BROWSER_TOKEN`.
4. Password fields are never filled by the browser tool.
5. Native app launching is allowlisted.
6. Arbitrary shell execution is intentionally not implemented here; LibreChat's code worker is used instead because it already provides workspace-scoped approval controls.
7. Browser page content is treated as untrusted data. It cannot alter system instructions or silently gain new native capabilities.

## Components

- `gateway/` — cloud relay and HTTP tool API.
- `companion/` — macOS outbound companion.
- `chrome-extension/` — active-tab browser bridge.

## Current milestone

Phase 1 establishes a safe browser/native-control transport while preserving the production LibreChat deployment. It does not modify `main`, MongoDB data, or live Render environment variables.

Next milestones:

1. Deploy the gateway as a separate Render service.
2. Pair the Mac companion.
3. Load the Chrome extension unpacked and validate active-tab control.
4. Connect gateway tools to LibreChat through an Agent Action/MCP adapter.
5. Enable/configure OpenAI + Gemini alongside the existing Anthropic provider.
6. Add dollar-denominated routing, budget enforcement, and dashboarding on top of LibreChat's existing provider token/cache usage records.
