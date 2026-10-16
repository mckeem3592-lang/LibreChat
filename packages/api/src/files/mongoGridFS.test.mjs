import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { GridFSBucket, MongoClient } from 'mongodb';
import ts from 'typescript';

const source = await readFile(new URL('./mongoGridFS.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022,
} }).outputText;
const { createMongoGridFSStore } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('document bytes survive a database client reconnect and are deletable', async t => {
  const mongod = await MongoMemoryServer.create();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mission-document-'));
  let client = new MongoClient(mongod.getUri());
  t.after(async () => { await client.close(); await mongod.stop(); await rm(directory, { recursive: true, force: true }); });
  await client.connect();
  const store = createMongoGridFSStore(() => new GridFSBucket(client.db('test'), { bucketName: 'mission_documents' }));
  const filePath = path.join(directory, 'report.pdf');
  const bytes = Buffer.from('%PDF-1.7\nprivate fixture');
  await writeFile(filePath, bytes);
  const fileId = 'ed487422-988b-440d-a62e-1d7029805392';
  const saved = await store.upload({ filePath, fileName: 'report.pdf', fileId,
    userId: 'owner', tenantId: 'tenant', maxBytes: 1024 });
  assert.equal(saved.filepath, `mongo-gridfs:${fileId}`);
  assert.equal(saved.bytes, bytes.length);
  await client.close();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  const chunks = [];
  for await (const chunk of store.download(saved.filepath)) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  const [record] = await new GridFSBucket(client.db('test'), { bucketName: 'mission_documents' })
    .find({ _id: fileId }).toArray();
  assert.equal(record.metadata.userId, 'owner');
  await store.delete(saved.filepath);
  await store.delete(saved.filepath);
  assert.equal((await new GridFSBucket(client.db('test'), { bucketName: 'mission_documents' })
    .find({ _id: fileId }).toArray()).length, 0);
  await assert.rejects(store.delete('mongo-gridfs:../../other'), /Invalid document storage reference/);
  await assert.rejects(store.upload({ filePath, fileName: 'report.pdf', fileId,
    userId: 'owner', maxBytes: 1 }), /exceeds storage limit/);
});
