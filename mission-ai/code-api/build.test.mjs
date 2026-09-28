import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = new URL('.', import.meta.url);
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const lockBytes = await readFile(new URL('package-lock.json', source));
const fingerprint = (await readFile(new URL('dependency-lock.sha256', source), 'utf8')).trim();

test('committed lock is complete, fingerprinted and restricted to integrity-checked public npm tarballs', () => {
  assert.equal(sha(lockBytes), fingerprint);
  const lock = JSON.parse(lockBytes);
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[''].name, 'code-execution-lambda');
  const packages = Object.entries(lock.packages).filter(([name]) => name);
  assert.equal(packages.length, 561);
  for (const [name, entry] of packages) {
    assert.ok(name.startsWith('node_modules/'));
    const url = new URL(entry.resolved);
    assert.equal(url.origin, 'https://registry.npmjs.org');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
    assert.ok(url.pathname.endsWith('.tgz'));
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.notEqual(entry.link, true);
  }
  assert.deepEqual(packages.filter(([, entry]) => entry.hasInstallScript).map(([name]) => name), [
    'node_modules/fsevents', 'node_modules/msgpackr-extract', 'node_modules/unrs-resolver',
  ]);
});

async function fixture(t, scenario = '') {
  const root = await mkdtemp(path.join(tmpdir(), 'mission-code-api-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wrapper = path.join(root, 'mission-ai/code-api');
  const bin = path.join(root, 'bin');
  await mkdir(wrapper, { recursive: true });
  await mkdir(path.join(wrapper, 'patches'));
  await mkdir(bin);
  for (const name of ['build.sh', 'package-lock.json', 'dependency-lock.sha256',
    'apply-dependency-patches.mjs', 'patches/dependency-patches.json']) {
    await writeFile(path.join(wrapper, name), await readFile(new URL(name, source)));
  }
  const stub = `#!${process.execPath}
const fs=require('node:fs'); const path=require('node:path'); const assert=require('node:assert/strict');
const tool=path.basename(process.argv[1]), args=process.argv.slice(2), root=process.env.TEST_BUILD_ROOT;
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({tool,args})+'\\n');
if(tool==='node') {
  assert.equal(path.basename(args[0]),'apply-dependency-patches.mjs');
  assert.ok(['check-runtime','prepare-manifest','patch-minio'].includes(args[1]));
  if(process.env.TEST_BUILD_SCENARIO==='manifest-failure' && args[1]==='prepare-manifest') process.exit(43);
  if(process.env.TEST_BUILD_SCENARIO==='patch-failure' && args[1]==='patch-minio') process.exit(44);
} else if(tool==='git') {
  if(args[0]==='clone') {
    assert.deepEqual(args.slice(0,3),['clone','--quiet','https://github.com/LibreChat-AI/code-interpreter.git']);
    const service=path.join(args[3],'service'); fs.mkdirSync(path.join(service,'src'),{recursive:true});
    fs.writeFileSync(path.join(service,'src/matplotlib-async.py'),'# fixture\\n');
  } else assert.deepEqual(args.slice(2),['checkout','--quiet','--detach','67d75d859aee891923c40cde1db073489d74a424']);
} else {
  const service=args[args.indexOf('--prefix')+1];
  assert.ok(args.includes('--ignore-scripts'));
  if(args[0]==='ci') {
    assert.ok(args.includes('--include=dev'));
    assert.deepEqual(fs.readFileSync(path.join(service,'package-lock.json')),fs.readFileSync(path.join(root,'mission-ai/code-api/package-lock.json')));
    if(process.env.TEST_BUILD_SCENARIO==='install-failure') process.exit(42);
    if(process.env.TEST_BUILD_SCENARIO==='mutate-lock') fs.appendFileSync(path.join(service,'package-lock.json'),' ');
  } else {
    assert.deepEqual(args.slice(0,2),['run','build']);
    if(process.env.TEST_BUILD_SCENARIO==='build-mutates-lock') fs.appendFileSync(path.join(service,'package-lock.json'),' ');
    fs.mkdirSync(path.join(service,'.build-service/src'),{recursive:true});
    fs.writeFileSync(path.join(service,'.build-service/src/service-api.js'),'// fixture\\n');
  }
}
`;
  for (const name of ['git', 'npm', 'node']) await writeFile(path.join(bin, name), stub, { mode: 0o755 });
  return { root, wrapper,
    run: () => spawnSync('bash', [path.join(wrapper, 'build.sh')], { cwd: root, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        TEST_BUILD_ROOT: root, TEST_BUILD_SCENARIO: scenario }, timeout: 10_000 }),
    calls: async () => {
      try { return (await readFile(path.join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
  };
}

test('wrapper installs retained lock bytes, suppresses hooks, builds exact source and preserves helper copying', async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Pinned Code API build: 67d75d859aee891923c40cde1db073489d74a424/);
  assert.ok(result.stdout.includes(fingerprint));
  const commands = await f.calls();
  assert.deepEqual(commands.map(({ tool, args }) => `${tool} ${tool === 'node' ? args[1] : args[0]}`), [
    'node check-runtime', 'git clone', 'git -C', 'node prepare-manifest',
    'npm ci', 'node patch-minio', 'npm run',
  ]);
  assert.ok(commands.every(({ args }) => !args.includes('install') && !args.includes('--package-lock-only')));
  assert.equal(await readFile(path.join(f.root, '.mission-ai-code-api/service/.build-service/src/matplotlib-async.py'), 'utf8'), '# fixture\n');
  assert.equal(sha(await readFile(path.join(f.root, '.mission-ai-code-api/service/package-lock.json'))), fingerprint);
});

for (const scenario of ['missing-lock', 'missing-fingerprint', 'empty-fingerprint', 'invalid-fingerprint',
  'changed-lock', 'missing-patch-script', 'missing-patch-manifest']) {
  test(`wrapper rejects ${scenario} before fetching or installing anything`, async (t) => {
    const f = await fixture(t);
    const hash = path.join(f.wrapper, 'dependency-lock.sha256');
    const lock = path.join(f.wrapper, 'package-lock.json');
    if (scenario === 'missing-lock') await rm(lock);
    if (scenario === 'missing-fingerprint') await rm(hash);
    if (scenario === 'empty-fingerprint') await writeFile(hash, '');
    if (scenario === 'invalid-fingerprint') await writeFile(hash, 'unreviewed');
    if (scenario === 'changed-lock') await writeFile(lock, '{}\n');
    if (scenario === 'missing-patch-script') await rm(path.join(f.wrapper, 'apply-dependency-patches.mjs'));
    if (scenario === 'missing-patch-manifest') await rm(path.join(f.wrapper, 'patches/dependency-patches.json'));
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.deepEqual(await f.calls(), []);
  });
}

for (const scenario of ['install-failure', 'mutate-lock', 'patch-failure']) {
  test(`wrapper blocks compilation after ${scenario}`, async (t) => {
    const f = await fixture(t, scenario);
    assert.notEqual(f.run().status, 0);
    const commands = await f.calls();
    assert.equal(commands.filter(({ tool }) => tool === 'npm').length, 1);
    assert.ok(!commands.some(({ tool, args }) => tool === 'npm' && args[0] === 'run'));
});
}

test('wrapper rejects unexpected source manifest before dependency installation', async (t) => {
  const f = await fixture(t, 'manifest-failure');
  assert.notEqual(f.run().status, 0);
  assert.ok(!(await f.calls()).some(({ tool }) => tool === 'npm'));
});

test('wrapper rejects a dependency lock changed during the explicit build', async (t) => {
  const f = await fixture(t, 'build-mutates-lock');
  assert.notEqual(f.run().status, 0);
  assert.ok((await f.calls()).some(({ tool, args }) => tool === 'npm' && args[0] === 'run'));
});
