// Run after build.sh. No server, Redis client connection, worker, or provider is started.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const service = path.resolve(process.env.MISSION_AI_CODE_API_TEST_SERVICE || '.mission-ai-code-api/service');
const requireService = createRequire(path.join(service, 'package.json'));

test('installed lock and upstream direct declarations match the reviewed source and retained graph', async () => {
  const manifestBytes = await readFile(path.join(service, 'package.json'));
  assert.equal(crypto.createHash('sha256').update(manifestBytes).digest('hex'),
    '2ab9f31664abc06b16f6edfd60c282b3eeacc8b3b705f966cb144e65eca28c82');
  const manifest = JSON.parse(manifestBytes);
  const lock = JSON.parse(await readFile(new URL('package-lock.json', import.meta.url)));
  for (const key of ['dependencies', 'devDependencies']) assert.deepEqual(lock.packages[''][key], manifest[key]);
  assert.deepEqual(await readFile(path.join(service, 'package-lock.json')),
    await readFile(new URL('package-lock.json', import.meta.url)));
});

test('installed message codec works without installation hooks, including explicit JavaScript fallback', () => {
  for (const fallback of [false, true]) {
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const { pack, unpack } = require('msgpackr');
      const value = { text: 'local-code-api-smoke', nested: [{ count: 3, enabled: true }] };
      assert.deepEqual(unpack(pack(value)), value);
    `], { cwd: service, env: { ...process.env, MSGPACKR_NATIVE_ACCELERATION_DISABLED: String(fallback) },
      encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('installed resolver loads its packaged binding and resolves a local module without postinstall', () => {
  const resolver = requireService('unrs-resolver');
  assert.equal(resolver.sync(service, './package.json').path, path.join(service, 'package.json'));
});

test('queue, Redis, storage and HTTP modules load without creating clients or listening', () => {
  assert.equal(typeof requireService('bullmq').Queue, 'function');
  assert.equal(typeof requireService('ioredis'), 'function');
  assert.equal(typeof requireService('minio').Client, 'function');
  assert.equal(typeof requireService('express'), 'function');
  assert.equal(typeof requireService('axios').request, 'function');
});
