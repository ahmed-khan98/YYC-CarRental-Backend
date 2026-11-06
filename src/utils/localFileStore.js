import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
  "video/3gpp": ".3gp",
  "image/heic": ".heic",
  "image/heif": ".heif",
};

export function getUploadsRoot() {
  if (process.env.UPLOAD_DIR) {
    return path.resolve(process.env.UPLOAD_DIR);
  }
  return path.join(PROJECT_ROOT, "public/uploads");
}

export function getTempRoot() {
  if (process.env.UPLOAD_TEMP_DIR) {
    return path.resolve(process.env.UPLOAD_TEMP_DIR);
  }
  return path.join(PROJECT_ROOT, "public/temp");
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
  return String(
    process.env.PUBLIC_BASE_URL ||
      process.env.FILE_PUBLIC_BASE_URL ||
      "https://api.yyccarrental.com",
  ).replace(/\/$/, "");
}

export function isStoredImageUrl(value) {
  if (typeof value !== "string") return false;
  const url = value.trim();
  if (!url) return false;
  if (/^https?:\/\//i.test(url)) return true;
  const path = url.startsWith("/") ? url : `/${url}`;
  return path.startsWith("/uploads/");
}

export function resolvePublicMediaUrl(url) {
  if (!url) return url;
  if (/^(https?:|data:|blob:)/i.test(String(url))) return url;
  const path = String(url).startsWith("/") ? String(url) : `/${url}`;
  if (!path.startsWith("/uploads/")) return url;
  return `${publicBaseUrl()}${path}`;
}

export function publicFileUrl(folder, filename) {
  const relative = `/uploads/${folder}/${filename}`;
  const base = publicBaseUrl();
  return base ? `${base}${relative}` : relative;
}

export async function ensureUploadsRoot() {
  await fs.mkdir(getUploadsRoot(), { recursive: true });
  await fs.mkdir(getTempRoot(), { recursive: true });
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

function bufferFromDataUrl(url) {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]+)$/i.exec(String(url));
  if (!match) return null;
  try {
    const isBase64 = Boolean(match[2]);
    return Buffer.from(decodeURIComponent(match[3]), isBase64 ? "base64" : "utf8");
  } catch {
    return null;
  }
}

async function fetchRemoteBuffer(url) {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length ? buffer : null;
  } catch {
    return null;
  }
}

export function resolveLocalUploadPath(url) {
  if (!url) return null;

  let pathname = String(url).trim();
  try {
    if (/^https?:\/\//i.test(pathname)) {
      pathname = new URL(pathname).pathname;
    }
  } catch {
    return null;
  }

  pathname = pathname.split("?")[0].split("#")[0];
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  try {
    pathname = decodeURI(pathname);
  } catch {
    // keep the raw path when it is not URI-encoded
  }
  if (!pathname.startsWith("/uploads/")) return null;

  const parts = pathname
    .slice("/uploads/".length)
    .split("/")
    .filter((part) => part && part !== "." && part !== "..");
  if (parts.length < 2) return null;

  const root = path.resolve(getUploadsRoot());
  const abs = path.resolve(root, ...parts);
  const relative = path.relative(root, abs);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return abs;
}

export async function readStoredFile(url) {
  if (!url) return null;
  const raw = String(url).trim();
  if (!raw) return null;

  if (raw.startsWith("data:")) {
    return bufferFromDataUrl(raw);
  }

  const localPath = resolveLocalUploadPath(raw);
  if (localPath) {
    try {
      return await fs.readFile(localPath);
    } catch {
      // Not on this disk (common for prod /uploads URLs on localhost). Fall back to HTTP.
    }
  }

  if (/^https?:\/\//i.test(raw)) {
    const remote = await fetchRemoteBuffer(raw);
    if (remote) return remote;
  }

  const publicUrl = resolvePublicMediaUrl(raw);
  if (publicUrl && publicUrl !== raw && /^https?:\/\//i.test(publicUrl)) {
    return fetchRemoteBuffer(publicUrl);
  }

  return null;
}

export async function fetchStoredPdf(url) {
  const buffer = await readStoredFile(url);
  if (!buffer || buffer.length < 5) return null;
  return buffer.subarray(0, 5).toString() === "%PDF-" ? buffer : null;
}
