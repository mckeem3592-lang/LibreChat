import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const source = fileURLToPath(new URL('../../packages/api/src/files/editedDocuments.ts', import.meta.url));
const moduleDir = await mkdtemp(path.join(os.tmpdir(), 'edited-doc-module-'));
const modulePath = path.join(moduleDir, 'editedDocuments.mts');
await writeFile(modulePath, await readFile(source));
const { publishEditedDocument, canDownloadEditedDocument, createEditedDocumentHandlers,
  createMcpEditedDocumentAuth, EditedDocumentError } =
  await import(pathToFileURL(modulePath).href);

test.after(async () => rm(moduleDir, { recursive: true, force: true }));

test('publishes exact bytes with an owner-scoped, expiring record', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'edited-doc-test-'));
  try {
    const bytes = Buffer.from('%PDF-1.7\n\x00\xff\n%%EOF');
    const temporaryPath = path.join(root, 'temp');
    await writeFile(temporaryPath, bytes);
    let storedRecord;
    const file = await publishEditedDocument({
      userId: 'owner',
      tenantId: 'tenant-a',
      originalname: '../report.pdf',
      temporaryPath,
      size: bytes.length,
      maxBytes: 1024,
      retentionHours: 24,
      uploadsPath: root,
      saveBuffer: async ({ userId, fileName, buffer }) => {
        await mkdir(path.join(root, userId));
        await writeFile(path.join(root, userId, fileName), buffer);
        return `/uploads/${userId}/${fileName}`;
      },
      createFile: async (record) => { storedRecord = record; return record; },
    });
    const stored = await readFile(path.join(root, 'owner', path.basename(file.filepath)));
    const hash = value => createHash('sha256').update(value).digest('hex');
    assert.equal(hash(stored), hash(bytes));
    assert.equal(file.filename, 'report.pdf');
    assert.equal(storedRecord.context, 'edited_document');
    assert.equal(canDownloadEditedDocument(file, 'owner', 'tenant-a'), true);
    assert.equal(canDownloadEditedDocument(file, 'other', 'tenant-a'), false);
    assert.equal(canDownloadEditedDocument(file, 'owner', 'tenant-b'), false);
    assert.equal(canDownloadEditedDocument(file, 'owner', 'tenant-a', new Date(Date.now() + 25 * 3600_000)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects wrong bytes, unsupported names, and oversized files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'edited-doc-test-'));
  try {
    const temporaryPath = path.join(root, 'temp');
    await writeFile(temporaryPath, Buffer.from('%PDF-not-a-docx'));
    let writes = 0;
    const input = {
      userId: 'owner', originalname: 'report.docx', temporaryPath, size: 15,
      maxBytes: 1024, retentionHours: 24, uploadsPath: root,
      saveBuffer: async () => { writes++; return '/uploads/owner/report.docx'; },
      createFile: async () => ({}),
    };
    await assert.rejects(publishEditedDocument(input), error => error instanceof EditedDocumentError && error.status === 415);
    await assert.rejects(publishEditedDocument({ ...input, originalname: 'script.exe' }), error => error.status === 415);
    await assert.rejects(publishEditedDocument({ ...input, maxBytes: 10 }), error => error.status === 413);
    assert.equal(writes, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('removes saved bytes when metadata persistence fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'edited-doc-test-'));
  try {
    const temporaryPath = path.join(root, 'temp');
    const bytes = Buffer.from('%PDF-1.7\n');
    await writeFile(temporaryPath, bytes);
    let savedPath;
    await assert.rejects(publishEditedDocument({
      userId: 'owner', originalname: 'report.pdf', temporaryPath,
      size: bytes.length, maxBytes: 1024, retentionHours: 24, uploadsPath: root,
      saveBuffer: async ({ userId, fileName, buffer }) => {
        await mkdir(path.join(root, userId));
        savedPath = path.join(root, userId, fileName);
        await writeFile(savedPath, buffer);
        return `/uploads/${userId}/${fileName}`;
      },
      createFile: async () => { throw new Error('database offline'); },
    }), /database offline/);
    await assert.rejects(readFile(savedPath), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('download handler denies unauthenticated and other-user requests, then streams exact bytes', async () => {
  const bytes = Buffer.from('%PDF-1.7\nprivate bytes');
  const record = {
    user: 'owner', tenantId: 'tenant-a', context: 'edited_document',
    expiredAt: new Date(Date.now() + 60_000), filename: 'private.pdf',
    filepath: '/uploads/owner/private.pdf',
  };
  class Reply extends Writable {
    constructor() { super(); this.chunks = []; this.headers = {}; this.statusCode = 200; }
    _write(chunk, encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
    status(code) { this.statusCode = code; return this; }
    json(value) { this.body = value; this.end(); return this; }
    setHeader(key, value) { this.headers[key] = value; return this; }
    attachment(filename) { this.headers['Content-Disposition'] = filename; return this; }
  }
  const handlers = createEditedDocumentHandlers({
    getMaxBytes: () => 1024, saveBuffer: async () => '', createFile: async () => ({}),
    getFiles: async () => [record], getDownloadStream: async () => Readable.from([bytes]),
    logger: { error: () => {} },
  });
  const anonymous = new Reply();
  await handlers.download({ params: { file_id: 'id' } }, anonymous);
  assert.equal(anonymous.statusCode, 401);
  const other = new Reply();
  await handlers.download({ params: { file_id: 'id' }, user: { id: 'other', tenantId: 'tenant-a' } }, other);
  assert.equal(other.statusCode, 404);
  const owner = new Reply();
  const finished = new Promise(resolve => owner.on('finish', resolve));
  await handlers.download({ params: { file_id: 'id' }, user: { id: 'owner', tenantId: 'tenant-a' } }, owner);
  await finished;
  assert.deepEqual(Buffer.concat(owner.chunks), bytes);
  assert.equal(owner.headers['Cache-Control'], 'no-store');
  assert.equal(owner.headers['X-Content-Type-Options'], 'nosniff');
});

test('MCP publishing requires the shared secret and a real LibreChat user', async () => {
  const userId = '0123456789abcdef01234567';
  const auth = createMcpEditedDocumentAuth({
    secret: 'example-secret',
    getUserById: async id => id === userId ? { id, role: 'USER', tenantId: 'tenant-a' } : null,
  });
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; } });
  const bad = response();
  await auth({ get: key => key === 'Authorization' ? 'Bearer wrong' : userId }, bad, () => { throw Error('unexpected'); });
  assert.equal(bad.statusCode, 401);
  const missing = response();
  await auth({ get: key => key === 'Authorization' ? 'Bearer example-secret' : 'ffffffffffffffffffffffff' }, missing,
    () => { throw Error('unexpected'); });
  assert.equal(missing.statusCode, 404);
  const request = { get: key => key === 'Authorization' ? 'Bearer example-secret' : userId };
  let called = false;
  await auth(request, response(), () => { called = true; });
  assert.equal(called, true);
  assert.equal(request.user.id, userId);
  assert.equal(request.user.tenantId, 'tenant-a');
});
