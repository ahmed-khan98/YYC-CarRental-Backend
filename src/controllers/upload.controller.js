import fs from "node:fs/promises";
import { uploadPdfToStorage, uploadToStorage } from "../utils/localFileStore.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { assertUploadSize } from "../middlewares/multer.middleware.js";
import {
  assembleChunkSession,
  createChunkSession,
  writeChunk,
} from "../utils/chunkUpload.js";

async function readUploadBuffer(file) {
  if (file?.buffer) return file.buffer;
  if (!file?.path) throw new ApiError(400, "No file uploaded");
  const buffer = await fs.readFile(file.path);
  await fs.unlink(file.path).catch(() => {});
  return buffer;
}

async function uploadBillAttachment(file) {
  assertUploadSize(file);
  const name = String(file?.originalname || "").toLowerCase();
  const isPdf = file?.mimetype === "application/pdf" || name.endsWith(".pdf");
  const buffer = await readUploadBuffer(file);
  const options = { filename: file.originalname, mimetype: file.mimetype };
  if (isPdf) return uploadPdfToStorage(buffer, "bill-attachments");
  return uploadToStorage(buffer, "bill-attachments", options);
}

const uploadFile = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, "No file uploaded");
  }
  assertUploadSize(req.file);

  const folder = req.body.folder ?? "yyc-car-rental";
  const buffer = await readUploadBuffer(req.file);
  const result = await uploadToStorage(buffer, folder, {
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
  });

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        url: result.secure_url,
        publicId: result.public_id,
      },
      "File uploaded",
    ),
  );
});

const uploadMultipleFiles = asyncHandler(async (req, res) => {
  if (!req.files?.length) {
    throw new ApiError(400, "No files uploaded");
  }

  const folder = req.body.folder ?? "yyc-car-rental";
  const results = await Promise.all(
    req.files.map(async (file) => {
      assertUploadSize(file);
      const buffer = await readUploadBuffer(file);
      return uploadToStorage(buffer, folder, {
        filename: file.originalname,
        mimetype: file.mimetype,
      });
    }),
  );

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        urls: results.map((r) => r.secure_url),
      },
      "Files uploaded",
    ),
  );
});

const startChunkUpload = asyncHandler(async (req, res) => {
  const meta = await createChunkSession({
    userId: req.user._id,
    filename: req.body?.filename,
    mimeType: req.body?.mimeType,
    folder: req.body?.folder ?? "yyc-car-rental",
    totalSize: req.body?.totalSize,
    chunkSize: req.body?.chunkSize,
  });

  return res.status(201).json(
    new ApiResponse(
      201,
      {
        uploadId: meta.id,
        chunkSize: meta.chunkSize,
        totalChunks: meta.totalChunks,
      },
      "Upload session started",
    ),
  );
});

const putChunkUpload = asyncHandler(async (req, res) => {
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
  await writeChunk(req.params.id, req.user._id, req.params.index, buffer);
  return res.status(200).json(new ApiResponse(200, { received: true }, "Chunk uploaded"));
});

const completeChunkUpload = asyncHandler(async (req, res) => {
  const { buffer, meta } = await assembleChunkSession(req.params.id, req.user._id);
  assertUploadSize({
    size: buffer.length,
    mimetype: meta.mimeType,
    originalname: meta.filename,
  });
  const result = await uploadToStorage(buffer, meta.folder, {
    filename: meta.filename,
    mimetype: meta.mimeType,
  });
  return res.status(200).json(
    new ApiResponse(
      200,
      {
        url: result.secure_url,
        publicId: result.public_id,
      },
      "File uploaded",
    ),
  );
});

export {
  uploadBillAttachment,
  uploadFile,
  uploadMultipleFiles,
  startChunkUpload,
  putChunkUpload,
  completeChunkUpload,
};
