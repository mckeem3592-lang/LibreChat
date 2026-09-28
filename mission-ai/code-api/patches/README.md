# Reviewed dependency patches

The Code API source pin remains `67d75d859aee891923c40cde1db073489d74a424` from
[LibreChat-AI/code-interpreter](https://github.com/LibreChat-AI/code-interpreter/tree/67d75d859aee891923c40cde1db073489d74a424).
The wrapper validates the exact original service manifest, adds only the scoped
MinIO/stream-json override, and verifies the resulting manifest fingerprint.
Direct dependency declarations and the existing decode-uri-component override
are retained. This is a tracked local adjustment to pinned source, not an
unmodified upstream build.

`minio-stream-json-3.patch` is derived from the published
[MinIO 8.0.7 npm package](https://registry.npmjs.org/minio/-/minio-8.0.7.tgz), whose
tarball integrity is retained in the dependency lock. Its upstream repository is
[minio/minio-js](https://github.com/minio/minio-js), and its original Apache 2.0
license is retained as `MinIO-LICENSE`. Copyright/license headers in all patched
files remain intact. The patch is a Mission AI compatibility change, not an
upstream MinIO release.

MinIO's JSONL notification parser import changes from `jsonl/Parser.js` to
`jsonl/parser.js`; its factory changes from `.make()` to `.asStream()`. The CJS
artifact explicitly selects the new ESM default export. These are the only two
replacements in each of the CJS, ESM, and matching TypeScript files. The script
uses the exact replacement and input/output hash records in
`dependency-patches.json`; the unified diff retains the reviewable source change.

This permits patched stream-json 3.7.0 and stream-chain 4.2.6 while retaining
MinIO 8.0.7. See the
[stream-json advisory](https://github.com/uhop/stream-json/security/advisories/GHSA-528h-pc64-c93x).
The manifest override and each vendor patch target fail closed on unexpected
bytes or versions. Every file is validated before patch writes begin. Repeat
application accepts only the exact reviewed patched bytes. Installation and
build lifecycle hooks remain disabled; the wrapper invokes this local patch
script explicitly.

The minimum supported runtime is Node 24.16.0. CI exercises exact Node 24.16.0 on
Linux. The compatibility tests use synthetic responses and network tripwires;
they cover both module formats, IAM class loading, token/UTF-8 boundaries,
record ordering, empty lines/records, EOF, errors, and existing stop behavior.
Empty LF lines remain accepted; whitespace-only JSON remains rejected. Stopping
can deliver already-buffered records but prevents later polling, as upstream did.
S3 transfer implementations and authorization behavior are not patched.

Future updates must review the versioned upstream diff, refresh manifest/target
hashes and the retained lock together, and pass patch guards, the real Linux
build/runtime tests, and the fresh zero-finding npm audit gate. Do not remove or
weaken fingerprint checks simply to accommodate new dependency output.
