const express = require('express');
const multer = require('multer');
const { logger } = require('@librechat/data-schemas');
const { FileSources, mergeFileConfig } = require('librechat-data-provider');
const {
  createFileUsageLimiter,
  createFileLimiters,
  configMiddleware,
  requireJwtAuth,
  uaParser,
  checkBan,
} = require('~/server/middleware');
const {
  restoreTenantContextFromReq,
  createEditedDocumentHandlers,
  createMcpEditedDocumentAuth,
} = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const db = require('~/models');
const { avatar: asstAvatarRouter } = require('~/server/routes/assistants/v1');
const { avatar: agentAvatarRouter } = require('~/server/routes/agents/v1');
const { createMulterInstance, createStorage } = require('./multer');

const files = require('./files');
const images = require('./images');
const avatar = require('./avatar');
const speech = require('./speech');

const initialize = async () => {
  const router = express.Router();
  const upload = await createMulterInstance();
  const editedUpload = multer({
    storage: createStorage({ uniqueTempPath: true }),
    limits: { fileSize: mergeFileConfig((await getAppConfig())?.fileConfig).serverFileSizeLimit },
  });
  const localFiles = getStrategyFunctions(FileSources.local);
  const editedDocuments = createEditedDocumentHandlers({
    getMaxBytes: (fileConfig) => mergeFileConfig(fileConfig).serverFileSizeLimit,
    saveBuffer: localFiles.saveBuffer,
    createFile: (file, disableTTL) => db.createFile(file, disableTTL),
    getFiles: (query) => db.getFiles(query),
    getDownloadStream: localFiles.getDownloadStream,
    logger,
  });
  const { fileUploadIpLimiter, fileUploadUserLimiter } = createFileLimiters();
  router.post(
    '/edited/mcp',
    createMcpEditedDocumentAuth({ secret: process.env.LOCAL_MCP_TOKEN, getUserById: db.getUserById }),
    configMiddleware,
    checkBan,
    uaParser,
    fileUploadIpLimiter,
    fileUploadUserLimiter,
    editedUpload.single('file'),
    restoreTenantContextFromReq,
    editedDocuments.upload,
  );

  router.use(requireJwtAuth);
  router.use(configMiddleware);
  router.use(checkBan);
  router.use(uaParser);

  // Record the failing stage without logging file contents or credentials.
  router.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/') {
      res.on('finish', () => {
        if (res.statusCode === 403) {
          logger.warn('[files/upload] Request denied', {
            role: req.user?.role,
            endpoint: req.body?.endpoint,
            toolResource: req.body?.tool_resource ?? null,
          });
        }
      });
    }
    next();
  });
  router.post('/speech/stt', upload.single('audio'), restoreTenantContextFromReq);

  /* Important: speech route must be added before the upload limiters */
  router.use('/speech', speech);

  const fileUsageLimiter = createFileUsageLimiter();

  /** Non-strict routing means `/usage/` reaches the same handler, so match the
   *  route the way Express does. An exact comparison would push a
   *  trailing-slash request onto the upload quota instead. */
  const isUsagePath = (path) => path.replace(/\/+$/, '') === '/usage';

  /** Apply rate limiters to all POST routes (excluding /speech which is handled
   *  above). `/usage` is a metadata touch, so it gets its own limiter rather
   *  than consuming upload quota, but it is never left unmetered. */
  router.use((req, res, next) => {
    if (req.method !== 'POST' || req.path.startsWith('/speech')) {
      return next();
    }
    if (isUsagePath(req.path)) {
      return fileUsageLimiter(req, res, next);
    }
    return fileUploadIpLimiter(req, res, (err) => {
      if (err) {
        return next(err);
      }
      return fileUploadUserLimiter(req, res, next);
    });
  });

  router.post('/', upload.single('file'), restoreTenantContextFromReq);
  router.post(
    '/edited',
    editedUpload.single('file'),
    restoreTenantContextFromReq,
    editedDocuments.upload,
  );
  router.get('/edited/:file_id', editedDocuments.download);
  router.post('/images', upload.single('file'), restoreTenantContextFromReq);
  router.post('/images/avatar', upload.single('file'), restoreTenantContextFromReq);
  router.post(
    '/images/agents/:agent_id/avatar',
    upload.single('file'),
    restoreTenantContextFromReq,
  );
  router.post(
    '/images/assistants/:assistant_id/avatar',
    upload.single('file'),
    restoreTenantContextFromReq,
  );

  router.use('/', files);
  router.use('/images', images);
  router.use('/images/avatar', avatar);
  router.use('/images/agents', agentAvatarRouter);
  router.use('/images/assistants', asstAvatarRouter);
  return router;
};

module.exports = { initialize };
