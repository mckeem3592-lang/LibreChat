import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';

const PREFIX = 'mongo-gridfs:';
const FILE_ID = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;

type Bucket = {
  openUploadStreamWithId: (
    id: string,
    filename: string,
    options: { metadata: Record<string, unknown> },
  ) => Writable;
  openDownloadStream: (id: string) => Readable;
  delete: (id: string) => Promise<void>;
};

type UploadInput = {
  filePath: string;
  fileName: string;
  fileId: string;
  userId: string;
  tenantId?: string;
  maxBytes: number;
};

type StoredUpload = { id: string; filepath: string; bytes: number };

type MongoGridFSStore = {
  upload: (input: UploadInput) => Promise<StoredUpload>;
  download: (reference: string) => Readable;
  delete: (reference: string) => Promise<void>;
};

function parseId(reference: string): string {
  if (typeof reference !== 'string' || !reference.startsWith(PREFIX)) {
    throw new Error('Invalid document storage reference');
  }
  const id = reference.slice(PREFIX.length);
  if (!FILE_ID.test(id)) throw new Error('Invalid document storage reference');
  return id;
}

/** File bytes live in the existing MongoDB connection, across web service restarts. */
export function createMongoGridFSStore(getBucket: () => Bucket): MongoGridFSStore {
  return {
    async upload(input: UploadInput): Promise<StoredUpload> {
      if (
        !FILE_ID.test(input.fileId) ||
        !input.userId ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 1
      ) {
        throw new Error('Invalid document upload');
      }
      const info = await stat(input.filePath);
      if (!info.isFile() || info.size > input.maxBytes) {
        throw new Error('Document upload exceeds storage limit');
      }
      const upload = getBucket().openUploadStreamWithId(input.fileId, input.fileName, {
        metadata: { userId: input.userId, tenantId: input.tenantId },
      });
      await pipeline(createReadStream(input.filePath), upload);
      return { id: input.fileId, filepath: `${PREFIX}${input.fileId}`, bytes: info.size };
    },
    download(reference: string): Readable {
      return getBucket().openDownloadStream(parseId(reference));
    },
    async delete(reference: string): Promise<void> {
      try {
        await getBucket().delete(parseId(reference));
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (/FileNotFound|file.*not found/i.test(message)) return;
        throw error;
      }
    },
  };
}
