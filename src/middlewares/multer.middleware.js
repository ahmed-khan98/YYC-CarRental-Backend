import fs from "node:fs";
import multer from "multer";
import { ApiError } from "../utils/ApiError.js";
import { getTempRoot } from "../utils/localFileStore.js";

export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const IMAGE_PDF_MAX_BYTES = 50 * 1024 * 1024;
export const BILL_ATTACHMENT_MAX_BYTES = IMAGE_PDF_MAX_BYTES;

export function isVideoFile(file) {
  const mime = String(file?.mimetype || "").toLowerCase();
  const name = String(file?.originalname || "").toLowerCase();
  return mime.startsWith("video/") || /\.(mp4|webm|mov|m4v|avi|mkv|ogv|ogg|3gp)$/i.test(name);
}

export function assertUploadSize(file) {
  const size = Number(file?.size || file?.buffer?.length || 0);
  if (isVideoFile(file)) {
    if (size > VIDEO_MAX_BYTES) {
      throw new ApiError(400, "Video must be 100MB or smaller");
    }
    return;
  }
  if (size > IMAGE_PDF_MAX_BYTES) {
    throw new ApiError(400, "Image or PDF must be 50MB or smaller");
  }
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = getTempRoot();
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + "-" + Math.round(Math.random() * Date.now());
    cb(null, unique + (file?.originalname || "file"));
  },
});

export const upload = multer({
  storage,
  limits: {
    fileSize: VIDEO_MAX_BYTES,
  },
});

function isAllowedBillAttachment(file) {
  const mime = String(file?.mimetype || "").toLowerCase();
  const name = String(file?.originalname || "").toLowerCase();
  return mime.startsWith("image/") || mime === "application/pdf" || name.endsWith(".pdf");
}

export const billAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BILL_ATTACHMENT_MAX_BYTES },
  fileFilter(_req, file, cb) {
    if (!isAllowedBillAttachment(file)) {
      cb(new ApiError(400, "Attachment must be a photo or PDF"));
      return;
    }
    cb(null, true);
  },
});
