import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const dependencyReview = JSON.parse(await readFile(
  new URL('patches/dependency-patches.json', import.meta.url), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function requireSupportedNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(match, 'Unrecognized Node version');
  const [, major, minor] = match.map(Number);
  assert.ok(major > 24 || major === 24 && minor >= 16, 'Code API requires Node >=24.16.0');
}

async function regularFile(file) {
  assert.ok((await lstat(file)).isFile(), 'Patch target must be a regular file');
  return readFile(file, 'utf8');
}

export async function prepareManifest(service, review = dependencyReview) {
  const target = path.join(service, 'package.json');
  const original = await regularFile(target);
  if (sha256(original) === review.upstreamManifest.patchedSha256) return false;
  assert.equal(sha256(original), review.upstreamManifest.originalSha256,
    'Unexpected pinned upstream manifest');
  const manifest = JSON.parse(original);
  manifest.overrides = { ...manifest.overrides, ...review.upstreamManifest.overrides };
  const patched = `${JSON.stringify(manifest, null, 2)}\n`;
  assert.equal(sha256(patched), review.upstreamManifest.patchedSha256,
    'Unexpected patched manifest');
  await writeFile(target, patched);
  return true;
}

export async function patchDependencies(service, review = dependencyReview) {
  assert.equal(sha256(await regularFile(path.join(service, 'package.json'))),
    review.upstreamManifest.patchedSha256, 'Expected reviewed service manifest');
  const target = path.resolve(service, 'node_modules/minio');
  const minioManifest = await regularFile(path.join(target, 'package.json'));
  assert.equal(sha256(minioManifest), review.minioPackageSha256, 'Unexpected MinIO manifest');
  assert.equal(JSON.parse(minioManifest).version, review.minioVersion, 'Unexpected MinIO version');
  for (const [name, expected] of [
    ['stream-json', review.streamJsonVersion], ['stream-chain', review.streamChainVersion],
  ]) {
    assert.equal(JSON.parse(await regularFile(path.join(service, 'node_modules', name, 'package.json'))).version,
      expected, `Unexpected ${name} version`);
  }
  const pending = [];
  for (const file of review.files) {
    const filePath = path.resolve(target, file.path);
    assert.ok(filePath.startsWith(`${target}${path.sep}`), 'Patch target must stay inside MinIO');
    const original = await regularFile(filePath);
    if (sha256(original) === file.patchedSha256) continue;
    assert.equal(sha256(original), file.originalSha256, `Unexpected MinIO source: ${file.path}`);
    let patched = original;
    for (const [before, after] of file.replacements) {
      assert.equal(patched.split(before).length, 2, `Unexpected patch match count: ${file.path}`);
      patched = patched.replace(before, after);
    }
    assert.equal(sha256(patched), file.patchedSha256, `Unexpected patch output: ${file.path}`);
    pending.push([filePath, patched]);
  }
  // Validate the entire patch first; an unexpected later source never leaves an
  // earlier file patched. The build stops on any subsequent filesystem failure.
  for (const [filePath, patched] of pending) await writeFile(filePath, patched);
  return pending.length;
}

export async function patchOwnerScope(service) {
  const target = path.join(service, 'src/auth/librechat-jwt.ts');
  const original = await regularFile(target);
  const upstreamHash = '4cfd1175bcf7c77b4691ecb0d770879876e7769a641f090fe79b5c207968e6ba';
  assert.equal(sha256(original), upstreamHash, 'Unexpected pinned JWT verifier source');
  const marker = '  assertAudience(claims.aud, config.audience);';
  assert.equal(original.split(marker).length, 2, 'JWT owner patch location changed');
  const patched = "import { missionAiOwnerMatches } from './mission-ai-owner-scope';\n" +
    original.replace(marker, marker + "\n  if (!missionAiOwnerMatches(userId, tenantId, process.env)) {\n    throw new CodeApiJwtAuthError('owner_denied', 'Mission AI owner authorization denied');\n  }");
  await writeFile(path.join(service, 'src/auth/mission-ai-owner-scope.ts'),
    await regularFile(new URL('owner-scope.ts', import.meta.url)));
  await writeFile(target, patched);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  requireSupportedNode();
  const [command, service] = process.argv.slice(2);
  if (command === 'check-runtime' && process.argv.length === 3) {
    // All validation is above; this command has no filesystem writes.
  } else if (service && process.argv.length === 4 && command === 'prepare-manifest') {
    await prepareManifest(path.resolve(service));
  } else if (service && process.argv.length === 4 && command === 'patch-minio') {
    await patchDependencies(path.resolve(service));
    await patchOwnerScope(path.resolve(service));
  } else {
    throw new Error('Expected check-runtime, prepare-manifest <service>, or patch-minio <service>');
  }
}
