const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');

const PREFIX = 'edited-gridfs:';
const ID_PATTERN = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;

const getBucket = () => {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !db) {
    throw new Error('Document database is unavailable');
  }
  return new GridFSBucket(db, { bucketName: 'edited_documents' });
};

const parseId = (filepath) => {
  if (typeof filepath !== 'string' || !filepath.startsWith(PREFIX)) {
    throw new Error('Invalid edited document reference');
  }
  const id = filepath.slice(PREFIX.length);
  if (!ID_PATTERN.test(id)) {
    throw new Error('Invalid edited document reference');
  }
  return id;
};

const saveBuffer = async ({ userId, tenantId, fileName, buffer }) => {
  const id = crypto.randomUUID();
  const bucket = getBucket();
  const upload = bucket.openUploadStreamWithId(id, fileName, {
    metadata: { userId, tenantId },
  });
  await pipeline(Readable.from([buffer]), upload);
  return `${PREFIX}${id}`;
};

const getDownloadStream = async (_req, filepath) =>
  getBucket().openDownloadStream(parseId(filepath));

const deleteStored = async (filepath) => {
  try {
    await getBucket().delete(parseId(filepath));
  } catch (error) {
    if (error?.code === 'FileNotFound' || /FileNotFound|file.*not found/i.test(error?.message)) {
      return;
    }
    throw error;
  }
};

const deleteFile = async (_req, file) => {
  if (file.context !== 'edited_document' || file.source !== 'edited_gridfs') {
    throw new Error('Invalid edited document record');
  }
  await deleteStored(file.filepath);
};

module.exports = { saveBuffer, getDownloadStream, deleteStored, deleteFile };
