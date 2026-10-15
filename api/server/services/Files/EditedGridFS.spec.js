const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { saveBuffer, getDownloadStream, deleteStored, deleteFile } = require('./EditedGridFS');

describe('edited document GridFS storage', () => {
  let mongo;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
  }, 120_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });

  it('retains bytes across a chat connection restart and deletes only edited records', async () => {
    const bytes = Buffer.from('%PDF-1.7\nprivate document bytes');
    const filepath = await saveBuffer({
      userId: 'owner',
      tenantId: 'tenant-a',
      fileName: 'report.pdf',
      buffer: bytes,
    });
    expect(filepath).toMatch(/^edited-gridfs:[a-f\d-]+$/);

    await mongoose.disconnect();
    await mongoose.connect(mongo.getUri());
    const chunks = [];
    for await (const chunk of await getDownloadStream(null, filepath)) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(bytes);

    await expect(
      deleteFile(null, { context: 'other', source: 'edited_gridfs', filepath }),
    ).rejects.toThrow('Invalid edited document record');
    await deleteFile(null, { context: 'edited_document', source: 'edited_gridfs', filepath });
    await expect(deleteStored(filepath)).resolves.toBeUndefined();
    await expect(deleteStored('edited-gridfs:../../other')).rejects.toThrow(
      'Invalid edited document reference',
    );
  }, 120_000);
});
