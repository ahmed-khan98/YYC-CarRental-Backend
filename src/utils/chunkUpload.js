import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ApiError } from "./ApiError.js";
import { VIDEO_MAX_BYTES } from "../middlewares/multer.middleware.js";

const TTL_MS = 30 * 60 * 1000;
const MAX_CHUNK_BYTES = 800 * 1024;

function sessionsRoot() {
  return path.resolve("public/temp/chunk-uploads");
}

function sessionDir(id) {
  return path.join(sessionsRoot(), id);
}

async function readMeta(id) {
  try {
    const raw = await fs.readFile(path.join(sessionDir(id), "meta.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    throw new ApiError(404, "Upload session not found");
  }
}

function assertOwner(meta, userId) {
  if (String(meta.userId) !== String(userId)) {
    throw new ApiError(403, "Forbidden");
  }
  if (Date.now() - Number(meta.createdAt) > TTL_MS) {
    throw new ApiError(410, "Upload session expired. Try again.");
  }
}

export async function cleanupStaleChunkSessions() {
  const root = sessionsRoot();
  let names = [];
  try {
    names = await fs.readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    names.map(async (name) => {
      try {
        const raw = await fs.readFile(path.join(root, name, "meta.json"), "utf8");
        const meta = JSON.parse(raw);
        if (Date.now() - Number(meta.createdAt) > TTL_MS) {
          await fs.rm(path.join(root, name), { recursive: true, force: true });
        }
      } catch {
        await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
      }
    }),
  );
}

export async function createChunkSession({ userId, filename, mimeType, folder, totalSize, chunkSize }) {
  const size = Number(totalSize);
  const piece = Number(chunkSize);
  if (!Number.isFinite(size) || size <= 0 || size > VIDEO_MAX_BYTES) {
    throw new ApiError(400, "File is too large to upload");
  }
  if (!Number.isFinite(piece) || piece < 32 * 1024 || piece > MAX_CHUNK_BYTES) {
    throw new ApiError(400, "Invalid upload chunk size");
  }

  await cleanupStaleChunkSessions();
  const id = randomUUID();
  const dir = sessionDir(id);
  await fs.mkdir(dir, { recursive: true });
  const totalChunks = Math.ceil(size / piece);
  if (totalChunks > 400) {
    throw new ApiError(400, "File is too large to upload");
  }

  const meta = {
    id,
    userId: String(userId),
    filename: String(filename || "upload").slice(0, 180),
    mimeType: String(mimeType || "application/octet-stream").slice(0, 120),
    folder: String(folder || "files").slice(0, 60),
    totalSize: size,
    chunkSize: piece,
    totalChunks,
    createdAt: Date.now(),
  };
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
  return meta;
}

export async function writeChunk(id, userId, index, buffer) {
  const meta = await readMeta(id);
  assertOwner(meta, userId);
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= meta.totalChunks) {
    throw new ApiError(400, "Invalid chunk index");
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ApiError(400, "Empty upload chunk");
  }
  const maxForIndex = i === meta.totalChunks - 1 ? meta.chunkSize : meta.chunkSize;
  if (buffer.length > maxForIndex) {
    throw new ApiError(400, "Upload chunk is too large");
  }
  if (i < meta.totalChunks - 1 && buffer.length !== meta.chunkSize) {
    throw new ApiError(400, "Upload chunk size mismatch");
  }
  await fs.writeFile(path.join(sessionDir(id), `${i}.part`), buffer);
  return meta;
}

export async function assembleChunkSession(id, userId) {
  const meta = await readMeta(id);
  assertOwner(meta, userId);

  const parts = [];
  for (let i = 0; i < meta.totalChunks; i += 1) {
    try {
      parts.push(await fs.readFile(path.join(sessionDir(id), `${i}.part`)));
    } catch {
      throw new ApiError(400, "Upload is incomplete. Try again.");
    }
  }

  const buffer = Buffer.concat(parts);
  if (buffer.length !== meta.totalSize) {
    throw new ApiError(400, "Uploaded file size did not match");
  }

  await fs.rm(sessionDir(id), { recursive: true, force: true }).catch(() => {});
  return { buffer, meta };
}
