import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dependencyReview, patchDependencies, prepareManifest, requireSupportedNode } from './apply-dependency-patches.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

async function fixture(t) {
  const service = await mkdtemp(path.join(tmpdir(), 'mission-code-api-patch-'));
  t.after(() => rm(service, { recursive: true, force: true }));
  const original = json({ name: 'fixture', dependencies: { minio: '^8.0.5' },
    overrides: { 'decode-uri-component': '0.5.0' } });
  const patched = json({ ...JSON.parse(original), overrides: {
    'decode-uri-component': '0.5.0', ...dependencyReview.upstreamManifest.overrides,
  } });
  const review = structuredClone(dependencyReview);
  review.upstreamManifest.originalSha256 = hash(original);
  review.upstreamManifest.patchedSha256 = hash(patched);
  await writeFile(path.join(service, 'package.json'), original);
  for (const [name, version] of [
    ['minio', review.minioVersion], ['stream-json', review.streamJsonVersion],
    ['stream-chain', review.streamChainVersion],
  ]) {
    await mkdir(path.join(service, 'node_modules', name), { recursive: true });
    const manifest = json({ name, version });
    await writeFile(path.join(service, 'node_modules', name, 'package.json'), manifest);
    if (name === 'minio') review.minioPackageSha256 = hash(manifest);
  }
  for (const file of review.files) {
    const target = path.join(service, 'node_modules/minio', file.path);
    await mkdir(path.dirname(target), { recursive: true });
    const before = file.replacements.map(([value]) => value).join('\n');
    const after = file.replacements.map(([, value]) => value).join('\n');
    file.originalSha256 = hash(before);
    file.patchedSha256 = hash(after);
    await writeFile(target, before);
  }
  const snapshot = () => Promise.all(review.files.map(file =>
    readFile(path.join(service, 'node_modules/minio', file.path), 'utf8')));
  return { service, review, original, patched, snapshot };
}

test('runtime rejects Node versions below the tested ESM interoperability floor', () => {
  for (const version of ['20.20.0', '22.22.0', '24.15.9', 'invalid']) {
    assert.throws(() => requireSupportedNode(version));
  }
  for (const version of ['24.16.0', '24.19.0', '26.10.0']) requireSupportedNode(version);
});

test('reviewed patch retains the upstream pin, exact versions, paths and public license', async () => {
  assert.equal(dependencyReview.upstreamCommit, '67d75d859aee891923c40cde1db073489d74a424');
  assert.equal(dependencyReview.minioVersion, '8.0.7');
  assert.equal(dependencyReview.streamJsonVersion, '3.7.0');
  assert.equal(dependencyReview.streamChainVersion, '4.2.6');
  assert.deepEqual(dependencyReview.files.map(file => file.path), [
    'dist/main/notification.js', 'dist/esm/notification.mjs', 'src/notification.ts',
  ]);
  for (const file of dependencyReview.files) {
    assert.match(file.originalSha256, /^[a-f0-9]{64}$/);
    assert.match(file.patchedSha256, /^[a-f0-9]{64}$/);
    assert.equal(file.replacements.length, 2);
  }
  assert.match(await readFile(new URL('patches/MinIO-LICENSE', import.meta.url), 'utf8'), /Apache License/);
});

test('manifest override preserves direct declarations and existing overrides and is idempotent', async (t) => {
  const f = await fixture(t);
  assert.equal(await prepareManifest(f.service, f.review), true);
  assert.equal(await readFile(path.join(f.service, 'package.json'), 'utf8'), f.patched);
  assert.deepEqual(JSON.parse(f.patched).dependencies, JSON.parse(f.original).dependencies);
  assert.equal(await prepareManifest(f.service, f.review), false);
});

test('unexpected original or resulting manifest fails without writing', async (t) => {
  const f = await fixture(t);
  f.review.upstreamManifest.patchedSha256 = '0'.repeat(64);
  await assert.rejects(prepareManifest(f.service, f.review), /Unexpected patched manifest/);
  assert.equal(await readFile(path.join(f.service, 'package.json'), 'utf8'), f.original);
  await writeFile(path.join(f.service, 'package.json'), `${f.original} `);
  await assert.rejects(prepareManifest(f.service, f.review), /Unexpected pinned upstream manifest/);
  assert.equal(await readFile(path.join(f.service, 'package.json'), 'utf8'), `${f.original} `);
});

test('all reviewed files patch to their exact fingerprints and repeated application does not write', async (t) => {
  const f = await fixture(t);
  await prepareManifest(f.service, f.review);
  assert.equal(await patchDependencies(f.service, f.review), 3);
  assert.deepEqual((await f.snapshot()).map(hash), f.review.files.map(file => file.patchedSha256));
  assert.equal(await patchDependencies(f.service, f.review), 0);
});

for (const scenario of ['source-drift', 'result-drift', 'duplicate-match', 'version-drift', 'parser-version-drift']) {
  test(`patch rejects ${scenario} before writing any of its files`, async (t) => {
    const f = await fixture(t);
    await prepareManifest(f.service, f.review);
    const last = f.review.files.at(-1);
    const target = path.join(f.service, 'node_modules/minio', last.path);
    if (scenario === 'source-drift') await writeFile(target, 'unexpected source');
    if (scenario === 'result-drift') last.patchedSha256 = '0'.repeat(64);
    if (scenario === 'duplicate-match') {
      const value = `${await readFile(target, 'utf8')}\n${last.replacements[0][0]}`;
      await writeFile(target, value);
      last.originalSha256 = hash(value);
    }
    if (scenario === 'version-drift') {
      const changed = json({ name: 'minio', version: '8.0.8' });
      await writeFile(path.join(f.service, 'node_modules/minio/package.json'), changed);
      f.review.minioPackageSha256 = hash(changed);
    }
    if (scenario === 'parser-version-drift') {
      await writeFile(path.join(f.service, 'node_modules/stream-json/package.json'), json({ version: '1.9.1' }));
    }
    const before = await f.snapshot();
    await assert.rejects(patchDependencies(f.service, f.review));
    assert.deepEqual(await f.snapshot(), before);
  });
}
