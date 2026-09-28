import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// This isolated acceptance suite never creates a real MinIO client, fetches
// credentials, or connects to a server. All response bodies below are synthetic.
const require = createRequire(import.meta.url);
const service = path.resolve(process.env.MISSION_AI_CODE_API_TEST_SERVICE || '.mission-ai-code-api/service');
const minioRoot = pathToFileURL(`${path.join(service, 'node_modules/minio')}${path.sep}`);
const formats = [
  { name: 'CJS', directory: 'main', extension: 'js' },
  { name: 'ESM', directory: 'esm', extension: 'mjs' },
];

function forbidNetwork(t) {
  const blocked = () => {
    throw new Error('Network access is forbidden in offline MinIO acceptance tests');
  };
  for (const [module, methods] of [
    [net, ['connect', 'createConnection']],
    [http, ['request', 'get']],
    [https, ['request', 'get']],
    [globalThis, ['fetch']],
  ]) {
    for (const method of methods) t.mock.method(module, method, blocked);
  }
  t.mock.method(net.Socket.prototype, 'connect', blocked);
}

async function load(format, filename) {
  const url = new URL(`dist/${format.directory}/${filename}.${format.extension}`, minioRoot);
  return format.name === 'CJS' ? require(fileURLToPath(url)) : import(url.href);
}

async function settle() {
  // Includes parser events, Promise callbacks, and nextTick repoll scheduling.
  await nextTurn();
  await nextTurn();
}

function harness(t, NotificationPoller, chunks, { stopAtEnd = true } = {}) {
  const response = Readable.from(chunks, { objectMode: false });
  const notifications = [];
  const errors = [];
  const requests = [];
  let parser;
  let complete;
  const completed = new Promise((resolve) => { complete = resolve; });
  const client = {
    region: 'us-east-1',
    async makeRequestAsync(...args) {
      requests.push(args);
      if (requests.length > 1) throw new Error('Unexpected synthetic repoll');
      return response;
    },
  };
  const poller = new NotificationPoller(client, 'offline-test-bucket', '', '', ['s3:ObjectCreated:*']);
  const originalPipe = response.pipe;
  response.pipe = function captureParser(destination, ...args) {
    parser = destination;
    destination.once('end', () => {
      if (stopAtEnd) poller.stop();
      complete({ kind: 'end' });
    });
    destination.once('error', (error) => {
      complete({ kind: 'error', error });
    });
    return originalPipe.call(this, destination, ...args);
  };
  poller.on('notification', (record) => notifications.push(record));
  poller.on('error', (error) => errors.push(error));
  t.after(() => {
    poller.stop();
    response.destroy();
    parser?.destroy();
  });
  return { poller, response, notifications, errors, requests, completed };
}

async function assertParsed(t, format, chunks, expected) {
  forbidNetwork(t);
  const { NotificationPoller } = await load(format, 'notification');
  const fixture = harness(t, NotificationPoller, chunks);
  fixture.poller.start();
  const terminal = await fixture.completed;
  await settle();
  assert.equal(terminal.kind, 'end');
  assert.deepEqual(fixture.errors, []);
  assert.deepEqual(fixture.notifications, expected);
  assert.equal(fixture.requests.length, 1, 'stopping at EOF prevents another request');
  assert.deepEqual(fixture.requests[0], [
    { method: 'GET', bucketName: 'offline-test-bucket', query: 'events=s3%3AObjectCreated%3A%2A' },
    '',
    [200],
    'us-east-1',
  ]);
}

for (const format of formats) {
  test(`${format.name}: MinIO and IamAwsProvider load without credentials or networking`, async (t) => {
    forbidNetwork(t);
    const minio = await load(format, 'minio');
    const provider = await load(format, 'IamAwsProvider');
    const notification = await load(format, 'notification');
    assert.equal(typeof minio.Client, 'function');
    assert.equal(typeof minio.IamAwsProvider, 'function');
    assert.equal(minio.IamAwsProvider, provider.IamAwsProvider);
    assert.equal(minio.NotificationPoller, notification.NotificationPoller);
  });

  test(`${format.name}: split JSON lines preserve multibyte UTF-8 records`, { timeout: 2000 }, async (t) => {
    const expected = [{ eventName: 's3:ObjectCreated:Put', key: 'café/漢字/🚀.json' }];
    const body = Buffer.from(`${JSON.stringify({ Records: expected })}\n`);
    // One-byte chunks deliberately split every multibyte character and token.
    const chunks = Array.from(body, (byte) => Buffer.from([byte]));
    await assertParsed(t, format, chunks, expected);
  });

  test(`${format.name}: multiple records and lines retain order`, { timeout: 2000 }, async (t) => {
    const expected = [{ key: 'one' }, { key: 'two' }, { key: 'three' }];
    const body = `${JSON.stringify({ Records: expected.slice(0, 2) })}\n${JSON.stringify({ Records: expected.slice(2) })}\n`;
    await assertParsed(t, format, [Buffer.from(body)], expected);
  });

  test(`${format.name}: blank lines and absent, null, or empty Records produce no notifications`, { timeout: 2000 }, async (t) => {
    const expected = [{ key: 'after-empty-records' }];
    // The old parser skips empty LF lines; it does not accept whitespace-only JSON.
    const body = `\n\n{}\n{"Records":null}\n{"Records":[]}\n${JSON.stringify({ Records: expected })}\n\n`;
    await assertParsed(t, format, [Buffer.from(body)], expected);
  });

  test(`${format.name}: empty response completes without notifications`, { timeout: 2000 }, async (t) => {
    await assertParsed(t, format, [], []);
  });

  test(`${format.name}: terminal JSON line without newline is emitted`, { timeout: 2000 }, async (t) => {
    const expected = [{ key: 'terminal-line' }];
    await assertParsed(t, format, [Buffer.from(JSON.stringify({ Records: expected }))], expected);
  });

  test(`${format.name}: malformed JSON forwards a handled error and does not repoll`, { timeout: 2000 }, async (t) => {
    forbidNetwork(t);
    const { NotificationPoller } = await load(format, 'notification');
    const fixture = harness(t, NotificationPoller, [Buffer.from('{"Records":[}\n')]);
    fixture.poller.start();
    const terminal = await fixture.completed;
    await settle();
    assert.equal(terminal.kind, 'error');
    assert.ok(terminal.error instanceof Error);
    assert.equal(fixture.errors.length, 1, 'parser error reaches the poller error listener once');
    assert.equal(fixture.errors[0], terminal.error);
    assert.deepEqual(fixture.notifications, []);
    assert.equal(fixture.requests.length, 1);
  });

  test(`${format.name}: whitespace-only JSON lines remain errors rather than being silently dropped`, { timeout: 2000 }, async (t) => {
    forbidNetwork(t);
    const { NotificationPoller } = await load(format, 'notification');
    const fixture = harness(t, NotificationPoller, [Buffer.from('  \n')]);
    fixture.poller.start();
    const terminal = await fixture.completed;
    await settle();
    assert.equal(terminal.kind, 'error');
    assert.ok(terminal.error instanceof Error);
    assert.equal(fixture.errors.length, 1);
    assert.equal(fixture.errors[0], terminal.error);
    assert.deepEqual(fixture.notifications, []);
    assert.equal(fixture.requests.length, 1);
  });

  test(`${format.name}: stopping before the scheduled first poll prevents requests`, { timeout: 2000 }, async (t) => {
    forbidNetwork(t);
    const { NotificationPoller } = await load(format, 'notification');
    const fixture = harness(t, NotificationPoller, []);
    fixture.poller.start();
    fixture.poller.stop();
    await settle();
    assert.equal(fixture.requests.length, 0);
    assert.deepEqual(fixture.notifications, []);
    assert.deepEqual(fixture.errors, []);
  });

  test(`${format.name}: stopping during a notification destroys the response and prevents later polls`, { timeout: 2000 }, async (t) => {
    forbidNetwork(t);
    const { NotificationPoller } = await load(format, 'notification');
    const records = [{ key: 'first' }, { key: 'already-buffered' }];
    const fixture = harness(t, NotificationPoller, [Buffer.from(`${JSON.stringify({ Records: records })}\n`)]);
    let first;
    const firstNotification = new Promise((resolve) => { first = resolve; });
    fixture.poller.once('notification', () => {
      fixture.poller.stop();
      first();
    });
    fixture.poller.start();
    await firstNotification;
    await settle();
    assert.equal(fixture.response.destroyed, true);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(fixture.errors, []);
    assert.deepEqual(fixture.notifications[0], records[0]);
    // Upstream stop() permits buffered events; this patch does not promise
    // immediate event suppression. Only subsequent polling must be prevented.
    assert.ok(fixture.notifications.length <= records.length);
    assert.deepEqual(fixture.notifications, records.slice(0, fixture.notifications.length));
    fixture.poller.checkForChanges();
    await settle();
    assert.equal(fixture.requests.length, 1);
  });
}
