import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/pdf": ".pdf",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
};

export function getUploadsRoot() {
  if (process.env.UPLOAD_DIR) {
    return path.resolve(process.env.UPLOAD_DIR);
  }
  return path.resolve("public/uploads");
}

function sanitizeFolder(folder = "files") {
  const cleaned = String(folder)
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("-")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 60);
  return cleaned || "files";
}

function extFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  if (buffer.subarray(0, 5).toString() === "%PDF-") return ".pdf";
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return ".png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return ".jpg";
  if (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") {
    return ".webp";
  }
  return "";
}

function extFromNameOrMime(filename = "", mime = "", fallback = "") {
  const fromName = path.extname(String(filename)).toLowerCase();
  if (fromName && fromName.length <= 8 && /^\.[a-z0-9.]+$/.test(fromName)) {
    return fromName;
  }
  if (MIME_EXT[String(mime).toLowerCase()]) {
    return MIME_EXT[String(mime).toLowerCase()];
  }
  return fallback;
}

function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || process.env.FILE_PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

export function publicFileUrl(folder, filename) {
  const relative = `/uploads/${folder}/${filename}`;
  const base = publicBaseUrl();
  return base ? `${base}${relative}` : relative;
}

export async function ensureUploadsRoot() {
  await fs.mkdir(getUploadsRoot(), { recursive: true });
  await fs.mkdir(path.resolve("public/temp"), { recursive: true });
}

export async function saveBuffer(buffer, folder, options = {}) {
  const safeFolder = sanitizeFolder(folder);
  const ext =
    options.ext ||
    extFromNameOrMime(options.filename, options.mimetype, "") ||
    extFromBuffer(buffer);
  const filename = `${randomUUID()}${ext}`;
  const dir = path.join(getUploadsRoot(), safeFolder);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), buffer);

  const url = publicFileUrl(safeFolder, filename);
  return {
    secure_url: url,
    url,
    public_id: `${safeFolder}/${filename}`,
  };
}

export async function uploadToStorage(buffer, folder = "files", options = {}) {
  return saveBuffer(buffer, folder, options);
}

export async function uploadPdfToStorage(buffer, folder = "documents") {
  return saveBuffer(buffer, folder, { ext: ".pdf", mimetype: "application/pdf" });
}

export function resolveLocalUploadPath(url) {
  if (!url) return null;

  let pathname = String(url);
  try {
    if (/^https?:\/\//i.test(pathname)) {
      pathname = new URL(pathname).pathname;
    }
  } catch {
    return null;
  }

  if (!pathname.startsWith("/uploads/")) return null;

  const parts = pathname
    .slice("/uploads/".length)
    .split("/")
    .filter((part) => part && part !== "." && part !== "..");
  if (parts.length < 2) return null;

  const root = path.resolve(getUploadsRoot());
  const abs = path.resolve(root, ...parts);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

export async function readStoredFile(url) {
  const localPath = resolveLocalUploadPath(url);
  if (localPath) {
    try {
      return await fs.readFile(localPath);
    } catch {
      return null;
    }
  }

  if (!url || !/^https?:\/\//i.test(url)) return null;
  const response = await fetch(url);
  if (!response.ok) return null;
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchStoredPdf(url) {
  const buffer = await readStoredFile(url);
  if (!buffer || buffer.length < 5) return null;
  return buffer.subarray(0, 5).toString() === "%PDF-" ? buffer : null;
}
