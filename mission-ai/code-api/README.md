# Mission AI Code API

This wrapper deploys the LibreChat Code API remote-bridge control plane from a
pinned source revision with reviewed dependency-manifest and MinIO compatibility
patches. The patches do not change Code API authentication or worker settings.

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

`package-lock.json` is the reviewed npm lock for the pinned upstream manifest
plus one scoped override: MinIO uses `stream-json` 3.7.0. The wrapper validates
the original manifest fingerprint before adding that override; all direct
dependency declarations remain intact. It requires the retained lock and its
SHA-256 fingerprint before fetching upstream, then uses `npm ci --ignore-scripts`.
It does not resolve semver ranges during deployment.
Only the pinned explicit Rollup build runs; dependency install hooks and
pre/post build hooks remain disabled. The lock is checked before and after
installation, after patching, and after the build.

MinIO 8.0.7 expects an older JSONL parser API. After installation, the wrapper
applies a small, retained patch to its CJS/ESM artifacts and matching TypeScript
source. All target versions and source/output fingerprints are checked before
any patch file is written. An unexpected source or package version stops the
build. Patch provenance, exact changes, and the retained Apache license are in
[patches/README.md](patches/README.md). Startup and runtime access settings are
unchanged. Node **24.16.0 or later** is required for the ESM interoperability
used by the patched CJS artifact; CI tests exact Node 24.16.0 on Linux.

The previous wrapper retained only a hash and regenerated a lock on every
build. Its older lock bytes were not retained, so the exact difference from
that historical npm dependency graph cannot be reconstructed. The replacement
base lock reproduced the reported failed-build hash. This security revision
changes only its `stream-json` and `stream-chain` entries; it is not a claim that
the dependencies remained unchanged across the earlier build repair.
See [dependency review](dependency-review.md) for versions and limitations.

Run the focused, offline wrapper checks with:

```sh
node --test mission-ai/code-api/build.test.mjs mission-ai/code-api/dependency-patches.test.mjs
```

Run the real installation/build from the repository root with Node 24.16.0:

```sh
bash mission-ai/code-api/build.sh
node --test mission-ai/code-api/runtime.test.mjs mission-ai/code-api/notification.test.mjs
npm audit --prefix .mission-ai-code-api/service --package-lock-only --include=dev --ignore-scripts --audit-level=low
```

Future dependency updates must replace the lock and fingerprint together,
review the package and advisory differences, and pass the wrapper, patch, real
build, and parser/runtime checks. CI rejects any low-or-higher audit finding and
also fails if the advisory service cannot be queried. It never runs audit fixes.
Runtime tests use synthetic streams and do not start a server, Redis connection,
worker, storage connection, or provider. Changing only the fingerprint does not
make resolution reproducible.
