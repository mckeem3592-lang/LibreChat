# Code API dependency review, 2026-09-28

Source remains pinned to `67d75d859aee891923c40cde1db073489d74a424`.
The wrapper applies a fingerprinted manifest override and a retained MinIO
compatibility patch. Authentication, Redis, sandbox, worker, and runtime access
settings do not change. See [patch provenance](patches/README.md).

- Upstream service manifest SHA-256: `2ab9f31664abc06b16f6edfd60c282b3eeacc8b3b705f966cb144e65eca28c82`.
- Patched service manifest SHA-256: `fbee4c8898091d7e084a0806f4341441b76888e8e11b0c62b38d98a17f9e3b00`.
- Checked-in npm lock SHA-256: `1aeb12e610809999d73b6f2c70e681810b5d2207cc7118c2e275fd7e2890dcd9`.
- The prior retained lock `330ecd1f410306dbadb96c5e9d2e983b3fc45c3f01976927324df7ee1db78675`
  reproduced the failed Render build's hash with npm 11.19.1. This revision
  changes only `stream-json` 1.9.1 to 3.7.0 and `stream-chain` 2.2.5 to 4.2.6.
- All 561 non-root lock entries use `https://registry.npmjs.org/` tarballs and
  SHA-512 integrity values; there are no Git, local-file, linked, or alternate
  registry dependencies.
- The 40 direct dependency declarations match the pinned service manifest.
- Install-script entries are `fsevents@2.3.3` (optional development binding),
  `msgpackr-extract@3.0.4` (optional native acceleration), and
  `unrs-resolver@1.12.2` (development resolver). The wrapper suppresses all
  lifecycle scripts. A clean install and Rollup build succeeded with them disabled.

The old approved npm lock with fingerprint
`2e21aa25df9bb912765cc1ade7d3a5a6cf0f63580bc55357edeafd56bb606838`
was not retained. Its exact package differences are unknown. A checksum alone
cannot recover that graph or establish that a changed checksum is harmless.

For an available reference, the pinned source includes `service/bun.lock`,
SHA-256 `9688b7fe256f8f8c665c039dff88b1238c5769f16045bb36b78e4bc857432687`.
The earlier 330ecd1 npm graph had 147 distinct name/version pairs differing from versions
recorded in that Bun lock, plus 15 name/version pairs whose names do not occur
there. This compares package versions across different package managers, not
the unrecovered old Render graph. Eleven direct resolutions differ:

| Dependency | Pinned upstream Bun lock | New npm lock |
| --- | --- | --- |
| axios | 1.13.2 | 1.20.0 |
| bullmq | 5.66.1 | 5.81.5 |
| express | 4.22.1 | 4.22.3 |
| ioredis | 5.8.2 | 5.11.1 |
| minio | 8.0.6 | 8.0.7 |
| @types/bun | 1.3.14 | 1.4.2 |
| @types/ioredis-mock | 8.2.7 | 8.2.8 |
| @types/node | 22.19.3 | 22.20.4 |
| @typescript-eslint/eslint-plugin | 8.50.0 | 8.71.0 |
| @typescript-eslint/parser | 8.50.0 | 8.71.0 |
| rollup | 2.79.2 | 2.80.0 |

The earlier lock's audit reported two moderate findings: `minio` depends on affected `stream-json`
([GHSA-528h-pc64-c93x](https://github.com/advisories/GHSA-528h-pc64-c93x)).
The advisory concerns expensive filtering of deeply nested JSON. npm's proposed
remediation downgrades MinIO to 7.1.3, outside the pinned manifest's major version
and below its IAM provider support. Instead, the reviewed override retains MinIO
8.0.7 and installs patched stream-json 3.7.0. Because its parser path and factory
changed, a six-replacement compatibility patch updates MinIO's CJS, ESM, and
TypeScript notification files. It does not suppress parse errors.

Fresh `npm audit --package-lock-only --include=dev --ignore-scripts` on the new
exact graph reported **zero findings** on 2026-09-28. CI repeats this check with
`--audit-level=low` and fails on findings or query errors. This is a current known
advisory check, not a guarantee that unreported vulnerabilities do not exist.

The original build repair used Node 26.10.0/npm 11.19.1 on macOS arm64: 530 applicable
packages installed with scripts disabled, unchanged lock hash, and successful
Rollup output. Runtime smoke checks passed for message encoding/decoding with
both normal loading and native acceleration explicitly disabled, the packaged
resolver binding, and queue/Redis/storage/HTTP module loads without connections.
Rollup emitted TS2345 and TS2352 diagnostics at three locations in pinned
source, plus source-map/export/circular-dependency warnings. Without the old
dependency graph, their presence in the prior build is unverified; build success
is not a clean upstream typecheck. The deployment CI must
also run the real wrapper with its pinned Node 24.16.0 on Linux. These checks
do not start the service or prove live Redis/worker connectivity.

The compatibility revision was separately installed and built on exact Node
24.16.0/npm 11.13.0 on macOS arm64 with hooks disabled. Its 20 CJS/ESM tests cover
IAM/module loading, UTF-8 chunking, JSONL records and empty lines, malformed input,
EOF, and existing cancellation behavior. The build still emits the three
documented TS2345/TS2352 warnings; no clean upstream typecheck is claimed.
Linux Node 24.16.0 CI runs the same parser tests against the real installed graph,
including case-sensitive import resolution. The patch changes only notification
parser integration; S3 transfer methods and their other dependencies are unchanged.
