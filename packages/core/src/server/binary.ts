import type { BinaryData } from '../types.js';
import { prisma } from './db.js';

/**
 * Storage for the bytes behind an item's binary.
 *
 * Nothing here decides policy. A node calls `ctx.writeBinary` to put bytes
 * somewhere they will not be re-read on every retry, and `ctx.readBinary` to
 * get them back; the runner wires both to this module. Bytes belonging to a run
 * go when the run does, by the cascade on `executionId`.
 */

/**
 * Refuse anything larger than this in a single object. Bytes are held in memory
 * whole on the way in and on the way out, so the ceiling is about what a worker
 * can hold, not about what Postgres will accept.
 */
const MAX_OBJECT_BYTES = Number(process.env.M8X_MAX_BINARY_BYTES ?? 25 * 1024 * 1024);

/** How long an object with no execution is kept before it is assumed orphaned. */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

export function maxBinaryBytes(): number {
  return MAX_OBJECT_BYTES;
}

export async function putBinary(input: {
  bytes: Uint8Array;
  mimeType: string;
  fileName?: string;
  executionId?: string;
}): Promise<BinaryData> {
  if (input.bytes.byteLength > MAX_OBJECT_BYTES) {
    throw new Error(
      `${input.fileName ?? 'a file'} is ${Math.round(input.bytes.byteLength / 1024 / 1024)} MB, over the ${Math.round(
        MAX_OBJECT_BYTES / 1024 / 1024,
      )} MB limit. Raise M8X_MAX_BINARY_BYTES to allow it.`,
    );
  }

  const row = await prisma.binaryObject.create({
    data: {
      executionId: input.executionId,
      mimeType: input.mimeType,
      fileName: input.fileName,
      size: input.bytes.byteLength,
      bytes: Buffer.from(input.bytes),
    },
    select: { id: true },
  });

  return {
    mimeType: input.mimeType,
    fileName: input.fileName,
    size: input.bytes.byteLength,
    ref: row.id,
  };
}

/** The bytes for a binary, whichever form it is in. */
export async function getBinary(binary: BinaryData): Promise<Uint8Array> {
  if (typeof binary.data === 'string') return Buffer.from(binary.data, 'base64');

  if (!binary.ref) {
    throw new Error('this binary has neither inline data nor a stored reference');
  }

  const row = await prisma.binaryObject.findUnique({
    where: { id: binary.ref },
    select: { bytes: true },
  });

  if (!row) {
    // Reachable by retrying a run whose execution was deleted, so it says what
    // happened rather than surfacing as an undefined further down.
    throw new Error(
      `the stored file ${binary.fileName ?? binary.ref} is no longer available; it is removed with its execution`,
    );
  }

  return row.bytes;
}

/**
 * Hand ownership of freshly stored objects to the execution that now refers to
 * them, so deleting the execution takes them with it. Called after the run row
 * exists, because a poller has to store the bytes before it can seed the item
 * that names them.
 */
export async function claimBinaries(refs: string[], executionId: string): Promise<void> {
  if (refs.length === 0) return;
  await prisma.binaryObject.updateMany({
    where: { id: { in: refs }, executionId: null },
    data: { executionId },
  });
}

/** Every ref reachable from a set of items, for claiming them in one call. */
export function refsIn(items: Array<{ binary?: Record<string, BinaryData> }>): string[] {
  const refs: string[] = [];
  for (const item of items) {
    for (const binary of Object.values(item.binary ?? {})) {
      if (binary.ref) refs.push(binary.ref);
    }
  }
  return refs;
}

/**
 * Drop objects that no execution ever claimed. An execution that failed to
 * queue leaves its attachments behind, and without this they would be the one
 * thing in the database that nothing ever deletes.
 */
export async function pruneOrphanBinaries(now = new Date()): Promise<number> {
  const { count } = await prisma.binaryObject.deleteMany({
    where: { executionId: null, createdAt: { lt: new Date(now.getTime() - ORPHAN_TTL_MS) } },
  });
  return count;
}
