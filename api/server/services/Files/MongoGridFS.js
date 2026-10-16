const mongoose = require('mongoose');
const { GridFSBucket } = require('mongodb');
const { createMongoGridFSStore } = require('@librechat/api');
const { FileSources, mergeFileConfig } = require('librechat-data-provider');

const store = createMongoGridFSStore(() => {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== 1 || !db) {
    throw new Error('Document database is unavailable');
  }
  return new GridFSBucket(db, { bucketName: 'mission_documents' });
});

const handleFileUpload = ({ req, file, file_id }) =>
  store.upload({
    filePath: file.path,
    fileName: file.originalname,
    fileId: file_id,
    userId: req.user.id,
    tenantId: req.user.tenantId,
    maxBytes: mergeFileConfig(req.config.fileConfig).serverFileSizeLimit,
  });

const getDownloadStream = (_req, filepath) => store.download(filepath);
const deleteFile = (_req, file) => {
  if (file.source !== FileSources.mongo_gridfs) throw new Error('Invalid document record');
  return store.delete(file.filepath);
};

module.exports = { handleFileUpload, getDownloadStream, deleteFile };
