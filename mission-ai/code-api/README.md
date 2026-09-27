# Mission AI Code API

This wrapper deploys the LibreChat Code API remote-bridge control plane without
vendoring or modifying upstream Code Interpreter source.

The upstream source is pinned to commit:

`67d75d859aee891923c40cde1db073489d74a424`

That is the exact revision referenced by this LibreChat checkout's native
workspace acceptance workflow. Render builds the pinned source into
`.mission-ai-code-api/` and starts only the API process.

The service is intended for:

- `CODEAPI_SANDBOX_BACKEND=remote-bridge`
- `CODEAPI_EXECUTION_PROFILE=stateful`
- `CODEAPI_RUNTIME_SESSION_MODE=affinity`
- paired, dynamic outbound Mac workers
- LibreChat JWT authentication

Redis is provided by the dedicated Mission AI Render Key Value instance. The
Mac worker connects outbound; no inbound Mac port is required.
