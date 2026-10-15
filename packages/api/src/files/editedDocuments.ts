import crypto from 'node:crypto';
import path from 'node:path';
import { readFile, unlink } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { Request, Response } from 'express';
import type { NextFunction } from 'express';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
};

export type EditedDocument = {
  user: string;
  tenantId?: string;
  file_id: string;
  bytes: number;
  filepath: string;
  filename: string;
  context: 'edited_document';
  source: 'local';
  type: string;
  expiredAt: Date;
};

export type EditedDocumentInput = {
  userId: string;
  tenantId?: string;
  originalname: string;
  temporaryPath: string;
  size: number;
  maxBytes: number;
  retentionHours: number;
  uploadsPath: string;
  saveBuffer: (input: {
    userId: string;
    tenantId?: string;
    fileName: string;
    basePath: 'uploads';
    buffer: Buffer;
  }) => Promise<string>;
  createFile: (file: EditedDocument, disableTTL: true) => Promise<object | null>;
};

export class EditedDocumentError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sanitizeEditedDocumentName(originalname: string): string {
  const basename = originalname.split(/[\\/]/).at(-1) ?? '';
  const cleaned = basename
    .replace(/[^\p{L}\p{N} ._()-]/gu, '_')
    .replace(/^\.+/, '')
    .trim();
  if (!cleaned || cleaned.length > 180 || !MIME_TYPES[path.extname(cleaned).toLowerCase()]) {
    throw new EditedDocumentError(415, 'Only DOCX, XLSX, and PDF files are supported');
  }
  return cleaned;
}

export function isEditedDocumentBytes(extension: string, bytes: Buffer): boolean {
  if (extension === '.pdf') {
    return bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
  }
  return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
}

export async function publishEditedDocument(input: EditedDocumentInput): Promise<EditedDocument> {
  const filename = sanitizeEditedDocumentName(input.originalname);
  const extension = path.extname(filename).toLowerCase();
  if (!Number.isInteger(input.size) || input.size < 1 || input.size > input.maxBytes) {
    throw new EditedDocumentError(413, 'File exceeds the configured upload size limit');
  }
  const buffer = await readFile(input.temporaryPath);
  if (buffer.length !== input.size || !isEditedDocumentBytes(extension, buffer)) {
    throw new EditedDocumentError(415, 'File bytes do not match the selected document type');
  }
  const fileId = crypto.randomUUID();
  const storedName = `${fileId}-${filename}`;
  const filepath = await input.saveBuffer({
    userId: input.userId,
    tenantId: input.tenantId,
    fileName: storedName,
    basePath: 'uploads',
    buffer,
  });
  const file: EditedDocument = {
    user: input.userId,
    tenantId: input.tenantId,
    file_id: fileId,
    bytes: buffer.length,
    filepath,
    filename,
    context: 'edited_document',
    source: 'local',
    type: MIME_TYPES[extension],
    expiredAt: new Date(Date.now() + input.retentionHours * 60 * 60 * 1000),
  };
  try {
    const saved = await input.createFile(file, true);
    if (!saved) throw new Error('Failed to save file metadata');
  } catch (error) {
    await unlink(path.join(input.uploadsPath, input.userId, storedName));
    throw error;
  }
  return file;
}

export function canDownloadEditedDocument(
  file: {
    user?: { toString(): string } | string;
    tenantId?: string;
    context?: string;
    expiredAt?: Date | string;
  },
  userId: string,
  tenantId?: string,
  now: Date = new Date(),
): boolean {
  return (
    file.context === 'edited_document' &&
    file.user?.toString() === userId &&
    (file.tenantId ?? undefined) === tenantId &&
    !!file.expiredAt &&
    new Date(file.expiredAt).getTime() > now.getTime()
  );
}

type FileRecord = EditedDocument & { user: string | { toString(): string } };
type EditedRequest = Request & {
  user?: { id: string; tenantId?: string };
  config?: { paths: { uploads: string }; fileConfig?: object; editedDocumentRetentionHours?: number };
  file?: Express.Multer.File;
};
type EditedDocumentHandlersDependencies = {
  getMaxBytes: (fileConfig?: object) => number;
  saveBuffer: EditedDocumentInput['saveBuffer'];
  createFile: EditedDocumentInput['createFile'];
  getFiles: (query: { file_id: string; user: string }) => Promise<FileRecord[]>;
  getDownloadStream: (req: Request, filepath: string) => Promise<Readable>;
  logger: { error: (message: string, error?: Error) => void };
};

type EditedDocumentHandlers = {
  upload: (request: Request, res: Response) => Promise<void>;
  download: (request: Request, res: Response) => Promise<void>;
};

export function createEditedDocumentHandlers(
  deps: EditedDocumentHandlersDependencies,
): EditedDocumentHandlers {
  return {
    upload: async (request: Request, res: Response): Promise<void> => {
      const req = request as EditedRequest;
      try {
        if (!req.user?.id) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }
        if (!req.file || !req.config) {
          res.status(400).json({ error: 'A document file is required' });
          return;
        }
        const file = await publishEditedDocument({
          userId: req.user.id,
          tenantId: req.user.tenantId,
          originalname: req.file.originalname,
          temporaryPath: req.file.path,
          size: req.file.size,
          maxBytes: deps.getMaxBytes(req.config.fileConfig),
          retentionHours: req.config.editedDocumentRetentionHours ?? 24,
          uploadsPath: req.config.paths.uploads,
          saveBuffer: deps.saveBuffer,
          createFile: deps.createFile,
        });
        res.setHeader('Cache-Control', 'no-store');
        res.status(201).json({
          file_id: file.file_id,
          filename: file.filename,
          type: file.type,
          bytes: file.bytes,
          expiredAt: file.expiredAt,
          downloadUrl: `/api/files/edited/${file.file_id}`,
        });
      } catch (error) {
        if (error instanceof EditedDocumentError) {
          res.status(error.status).json({ error: error.message });
        } else {
          deps.logger.error(
            '[edited documents] Upload failed',
            error instanceof Error ? error : undefined,
          );
          res.status(500).json({ error: 'Unable to publish document' });
        }
      } finally {
        if (req.file?.path) {
          await unlink(req.file.path).catch(() => undefined);
        }
      }
    },
    download: async (request: Request, res: Response): Promise<void> => {
      const req = request as EditedRequest;
      try {
        if (!req.user?.id) {
          res.status(401).json({ error: 'Authentication required' });
          return;
        }
        const [file] = await deps.getFiles({
          file_id: String(req.params.file_id),
          user: req.user.id,
        });
        if (!file || !canDownloadEditedDocument(file, req.user.id, req.user.tenantId)) {
          res.status(404).json({ error: 'Document unavailable' });
          return;
        }
        const stream = await deps.getDownloadStream(req, file.filepath);
        stream.on('error', (error: Error) => {
          deps.logger.error('[edited documents] Download failed', error);
          if (res.headersSent) res.destroy();
          else res.status(404).json({ error: 'Document unavailable' });
        });
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.attachment(file.filename);
        res.setHeader('Content-Type', 'application/octet-stream');
        stream.pipe(res);
      } catch (error) {
        deps.logger.error(
          '[edited documents] Download failed',
          error instanceof Error ? error : undefined,
        );
        if (!res.headersSent) res.status(500).json({ error: 'Unable to download document' });
      }
    },
  };
}

type PublisherUser = {
  _id?: { toString(): string };
  id?: string;
  role?: string;
  tenantId?: string;
  toObject?: () => PublisherUser;
};

export function createMcpEditedDocumentAuth(deps: {
  secret?: string;
  getUserById: (userId: string) => Promise<PublisherUser | null>;
}): (request: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (request: Request, res: Response, next: NextFunction): Promise<void> => {
    const supplied = request.get('Authorization')?.replace(/^Bearer /, '') ?? '';
    const expected = deps.secret ?? '';
    const userId = request.get('X-LibreChat-User-ID') ?? '';
    if (
      !expected ||
      !/^[a-f\d]{24}$/i.test(userId) ||
      supplied.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const user = await deps.getUserById(userId);
      if (!user) {
        res.status(404).json({ error: 'User unavailable' });
        return;
      }
      const plain = user.toObject?.() ?? user;
      (request as EditedRequest).user = {
        ...plain,
        id: userId,
        tenantId: plain.tenantId?.toString(),
      };
      next();
    } catch {
      res.status(500).json({ error: 'Unable to authenticate document owner' });
    }
  };
}
