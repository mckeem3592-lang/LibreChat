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

## Reproducible dependency installation

`package-lock.json` is the reviewed npm lock for the pinned upstream
`service/package.json`. The wrapper requires that file and its SHA-256
fingerprint before fetching upstream, copies it into the service, and uses
`npm ci --ignore-scripts`. It does not resolve semver ranges during deployment.
Only the pinned explicit Rollup build runs; dependency install hooks and
pre/post build hooks remain disabled. Startup and runtime access settings are
unchanged.

The previous wrapper retained only a hash and regenerated a lock on every
build. Its older lock bytes were not retained, so the exact difference from
that historical npm dependency graph cannot be reconstructed. The replacement
lock reproduces the reported failed-build hash and has been inspected and
installed explicitly; it is not a claim that the dependencies remained unchanged.
See [dependency review](dependency-review.md) for versions and limitations.

Run the focused, offline wrapper checks with:

```sh
node --test mission-ai/code-api/build.test.mjs
```

Run the real installation/build from the repository root with Node 24.16.0:

```sh
bash mission-ai/code-api/build.sh
node --test mission-ai/code-api/runtime.test.mjs
```

Future dependency updates must replace the lock and fingerprint together,
review the package and advisory differences, and pass the wrapper tests and
real build and module-load smoke checks. The latter do not start a server,
Redis connection, worker, or provider. Changing only the fingerprint does not
make resolution reproducible.
