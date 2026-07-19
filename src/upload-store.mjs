// StoryCut upload-store: a tiny path + ffprobe helper for /api/upload.
// All transient media artifacts live under .work/ (gitignored). No business
// logic here — keeps server.mjs declarative.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// Hidden dependency on cwd: we anchor .work/ to the repo root so the
// project's own gitignore protects everything. STORYCUT_WORK_DIR lets ops
// override (e.g. when running from a packaged build).
export const workDir = process.env.STORYCUT_WORK_DIR
  ? path.resolve(process.env.STORYCUT_WORK_DIR)
  : path.resolve(process.cwd(), ".work");

export const uploadsDir = path.join(workDir, "uploads");
export const transcriptsDir = path.join(workDir, "transcripts");

const ALLOWED_EXTENSIONS = new Set([".mp4", ".mov", ".m4a", ".wav", ".mp3"]);
const FILE_ID_PATTERN = /^[a-f0-9]{16}$/;

export async function ensureDirs() {
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.mkdir(transcriptsDir, { recursive: true });
}

export function newFileId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}

// Whitelist file extensions. Anything else (exe, zip, unknown) is rejected
// before we touch disk.
export function safeExtension(name) {
  const m = String(name || "").toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  if (!m) return "";
  const ext = "." + m[1];
  return ALLOWED_EXTENSIONS.has(ext) ? ext : "";
}

export function uploadPathFor(fileId, originalName) {
  if (!FILE_ID_PATTERN.test(String(fileId))) {
    throw new Error("Invalid fileId");
  }
  const ext = safeExtension(originalName);
  return path.join(uploadsDir, `${fileId}${ext}`);
}

export function isAllowedExtension(ext) {
  return ALLOWED_EXTENSIONS.has(String(ext || "").toLowerCase());
}

// Find the on-disk path matching a fileId (extension is unknown to the caller).
// Returns null when no such file exists.
export async function findUpload(fileId) {
  if (!FILE_ID_PATTERN.test(String(fileId))) return null;
  await ensureDirs();
  const entries = await fs.readdir(uploadsDir);
  for (const entry of entries) {
    if (entry.startsWith(fileId + ".") || entry === fileId) {
      return path.join(uploadsDir, entry);
    }
  }
  return null;
}

// Run ffprobe and return a flat, frontend-friendly object. Tolerates non-zero
// exits so we can surface the message as a 400.
export async function ffprobe(filePath, { bin = "ffprobe" } = {}) {
  const { stdout } = await execFileP(bin, [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ], { maxBuffer: 4 * 1024 * 1024 });
  const data = JSON.parse(stdout);
  const format = data.format || {};
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const audio = streams.find((s) => s.codec_type === "audio") || {};
  const video = streams.find((s) => s.codec_type === "video") || {};
  const duration = Number(format.duration ?? audio.duration ?? 0);
  return {
    duration: Number.isFinite(duration) ? Number(duration.toFixed(2)) : 0,
    sizeBytes: Number(format.size) || 0,
    bitRate: Number(format.bit_rate) || 0,
    formatName: format.format_name || "",
    audio: {
      codec: audio.codec_name || "",
      sampleRate: Number(audio.sample_rate) || 0,
      channels: audio.channels || 0,
    },
    video: video.codec_name
      ? {
          codec: video.codec_name,
          width: video.width || 0,
          height: video.height || 0,
        }
      : null,
  };
}

export const constants = Object.freeze({
  ALLOWED_EXTENSIONS,
  FILE_ID_PATTERN,
});
