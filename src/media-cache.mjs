import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_MEDIA_CACHE_ROOT = process.env.STORYCUT_CACHE_DIR
  || path.join(os.homedir(), "Library", "Caches", "StoryCut");

const DEFAULT_MAX_MEDIA_CACHE_BYTES = Number(process.env.STORYCUT_MEDIA_CACHE_MAX_BYTES)
  || 20 * 1024 * 1024 * 1024;
const MIN_MEDIA_CACHE_BYTES = 1024 * 1024 * 1024;
const MAX_MEDIA_CACHE_BYTES = 200 * 1024 * 1024 * 1024;
const DEFAULT_FREE_SPACE_RESERVE_BYTES = Number(process.env.STORYCUT_CACHE_RESERVE_BYTES)
  || 1024 * 1024 * 1024;
const DEFAULT_PROXY_MAX_EDGE = Number(process.env.STORYCUT_PROXY_MAX_EDGE) || 1280;
const DEFAULT_PROXY_VIDEO_BITRATE = Number(process.env.STORYCUT_PROXY_VIDEO_BITRATE) || 2_000_000;
const DEFAULT_PROXY_AUDIO_BITRATE = Number(process.env.STORYCUT_PROXY_AUDIO_BITRATE) || 128_000;
const DEFAULT_PROXY_THREADS = Number(process.env.STORYCUT_PROXY_THREADS) || 2;
const MAX_THUMBNAIL_WORKERS = 2;
const MAX_PROXY_WORKERS = 1;
const PLAYBACK_PROXY_VERSION = "playback-proxy-v1";
const CACHE_SETTINGS_VERSION = 1;
const PROJECT_CACHE_VERSION = 1;
const mediaProxyJobs = new Map();
const proxyQueue = [];
const thumbnailJobs = new Map();
const thumbnailQueue = [];
let activeProxyWorkers = 0;
let activeThumbnailWorkers = 0;
const projectManifestLocks = new Map();

function hash(value, length = 24) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function validProjectId(value) {
  const projectId = String(value || "");
  return /^[a-f0-9]{24}$/.test(projectId) ? projectId : null;
}

function validCacheId(value) {
  const cacheId = String(value || "");
  return /^[a-f0-9]{24}$/.test(cacheId) ? cacheId : null;
}

function projectCacheDirectory(cacheRoot) {
  return path.join(cacheRoot, "project-cache");
}

function projectCacheManifestPath(projectId, cacheRoot) {
  return path.join(projectCacheDirectory(cacheRoot), `${projectId}.json`);
}

function emptyProjectCacheManifest(projectId) {
  return {
    schemaVersion: PROJECT_CACHE_VERSION,
    projectId,
    media: [],
    thumbnails: [],
    updatedAt: new Date().toISOString()
  };
}

async function readProjectCacheManifest(projectId, cacheRoot = DEFAULT_MEDIA_CACHE_ROOT) {
  const safeId = validProjectId(projectId);
  if (!safeId) return null;
  const raw = await fs.readFile(projectCacheManifestPath(safeId, cacheRoot), "utf8").catch(() => "");
  if (!raw) return emptyProjectCacheManifest(safeId);
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.schemaVersion !== PROJECT_CACHE_VERSION || parsed.projectId !== safeId) {
      return emptyProjectCacheManifest(safeId);
    }
    return {
      ...emptyProjectCacheManifest(safeId),
      media: [...new Set((parsed.media || []).map(validCacheId).filter(Boolean))],
      thumbnails: [...new Set((parsed.thumbnails || []).map(validCacheId).filter(Boolean))],
      updatedAt: parsed.updatedAt || null
    };
  } catch {
    return emptyProjectCacheManifest(safeId);
  }
}

async function writeProjectCacheManifest(manifest, cacheRoot = DEFAULT_MEDIA_CACHE_ROOT) {
  const projectId = validProjectId(manifest?.projectId);
  if (!projectId) throw new Error("Invalid StoryCut project cache id.");
  const directory = projectCacheDirectory(cacheRoot);
  await fs.mkdir(directory, { recursive: true });
  const targetPath = projectCacheManifestPath(projectId, cacheRoot);
  const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  const payload = {
    schemaVersion: PROJECT_CACHE_VERSION,
    projectId,
    media: [...new Set((manifest.media || []).map(validCacheId).filter(Boolean))],
    thumbnails: [...new Set((manifest.thumbnails || []).map(validCacheId).filter(Boolean))],
    updatedAt: new Date().toISOString()
  };
  if (!payload.media.length && !payload.thumbnails.length) {
    await fs.rm(targetPath, { force: true });
    return payload;
  }
  await fs.writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, "utf8");
  await fs.rename(temporaryPath, targetPath);
  return payload;
}

async function withProjectManifestLock(projectId, cacheRoot, task) {
  const key = `${path.resolve(cacheRoot)}:${projectId}`;
  const previous = projectManifestLocks.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  projectManifestLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (projectManifestLocks.get(key) === current) projectManifestLocks.delete(key);
  }
}

export async function registerProjectCacheEntry(projectId, section, cacheId, cacheRoot = DEFAULT_MEDIA_CACHE_ROOT) {
  const safeProjectId = validProjectId(projectId);
  const safeCacheId = validCacheId(cacheId);
  if (!safeProjectId || !safeCacheId || !new Set(["media", "thumbnails"]).has(section)) return false;
  await withProjectManifestLock(safeProjectId, cacheRoot, async () => {
    const manifest = await readProjectCacheManifest(safeProjectId, cacheRoot);
    if (!manifest[section].includes(safeCacheId)) manifest[section].push(safeCacheId);
    await writeProjectCacheManifest(manifest, cacheRoot);
  });
  return true;
}

function configuredEnvironmentLimit() {
  const raw = process.env.STORYCUT_MEDIA_CACHE_MAX_BYTES;
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function settingsPath(cacheRoot) {
  return path.join(cacheRoot, "cache-settings.json");
}

export async function mediaCacheSettings(cacheRoot = DEFAULT_MEDIA_CACHE_ROOT) {
  const environmentLimit = configuredEnvironmentLimit();
  if (environmentLimit !== null) {
    return {
      mediaMaxBytes: Math.round(environmentLimit),
      source: "environment",
      editable: false,
      minBytes: MIN_MEDIA_CACHE_BYTES,
      maxBytes: MAX_MEDIA_CACHE_BYTES
    };
  }
  const raw = await fs.readFile(settingsPath(cacheRoot), "utf8").catch(() => "");
  let stored = 0;
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed?.schemaVersion === CACHE_SETTINGS_VERSION) stored = Number(parsed.mediaMaxBytes) || 0;
  } catch {
    stored = 0;
  }
  return {
    mediaMaxBytes: Math.min(MAX_MEDIA_CACHE_BYTES, Math.max(MIN_MEDIA_CACHE_BYTES, Math.round(stored || DEFAULT_MAX_MEDIA_CACHE_BYTES))),
    source: stored ? "settings" : "default",
    editable: true,
    minBytes: MIN_MEDIA_CACHE_BYTES,
    maxBytes: MAX_MEDIA_CACHE_BYTES
  };
}

export async function updateMediaCacheSettings(mediaMaxBytes, cacheRoot = DEFAULT_MEDIA_CACHE_ROOT) {
  const current = await mediaCacheSettings(cacheRoot);
  if (!current.editable) throw new Error("播放代理容量由 STORYCUT_MEDIA_CACHE_MAX_BYTES 环境变量管理。");
  const value = Number(mediaMaxBytes);
  if (!Number.isFinite(value) || value < MIN_MEDIA_CACHE_BYTES || value > MAX_MEDIA_CACHE_BYTES) {
    throw new Error("播放代理容量必须设置在 1 GB 到 200 GB 之间。");
  }
  await fs.mkdir(cacheRoot, { recursive: true });
  const targetPath = settingsPath(cacheRoot);
  const temporaryPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify({
    schemaVersion: CACHE_SETTINGS_VERSION,
    mediaMaxBytes: Math.round(value),
    updatedAt: new Date().toISOString()
  })}\n`, "utf8");
  await fs.rename(temporaryPath, targetPath);
  await pruneMediaCache(cacheRoot, { maxBytes: value });
  return mediaCacheSettings(cacheRoot);
}

async function sourceIdentity(filePath) {
  const absolute = path.resolve(filePath);
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error("Cache source is not a file.");
  const signature = `${absolute}\0${stat.size}\0${Math.floor(stat.mtimeMs)}`;
  return { absolute, stat, id: hash(signature) };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 5000) stderr = stderr.slice(-5000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function runProcessOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 2_000_000) stdout = stdout.slice(-2_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function runProcessProgress(command, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuffer = "";
    let stderr = "";
    let outTimeSeconds = 0;
    const consumeLine = (line) => {
      const separator = line.indexOf("=");
      if (separator < 0) return;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      if (key === "out_time_us" || key === "out_time_ms") {
        const parsed = Number(value) / 1_000_000;
        if (Number.isFinite(parsed)) outTimeSeconds = Math.max(outTimeSeconds, parsed);
      }
      if (key === "progress") onProgress?.(outTimeSeconds, value);
    };
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      lines.forEach(consumeLine);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (stdoutBuffer) consumeLine(stdoutBuffer);
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function pumpThumbnailQueue() {
  while (activeThumbnailWorkers < MAX_THUMBNAIL_WORKERS && thumbnailQueue.length) {
    const entry = thumbnailQueue.shift();
    activeThumbnailWorkers += 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        activeThumbnailWorkers -= 1;
        thumbnailJobs.delete(entry.key);
        pumpThumbnailQueue();
      });
  }
}

function enqueueThumbnail(key, task) {
  if (thumbnailJobs.has(key)) return thumbnailJobs.get(key);
  const promise = new Promise((resolve, reject) => {
    thumbnailQueue.push({ key, task, resolve, reject });
    pumpThumbnailQueue();
  });
  thumbnailJobs.set(key, promise);
  return promise;
}

async function cachedFileReady(filePath, expectedSize = null) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0) return false;
  return expectedSize === null || stat.size === expectedSize;
}

export async function getFirstFrameThumbnail(filePath, options = {}) {
  const cacheRoot = options.cacheRoot || DEFAULT_MEDIA_CACHE_ROOT;
  const requestedAt = Number(options.at);
  const at = Number(Math.max(0, Number.isFinite(requestedAt) ? requestedAt : 0.05).toFixed(3));
  const source = await sourceIdentity(filePath);
  const cacheId = hash(`${source.id}\0${at.toFixed(3)}\0v1`);
  const directory = path.join(cacheRoot, "thumbnails");
  const targetPath = path.join(directory, `${cacheId}.jpg`);
  if (await cachedFileReady(targetPath)) {
    await registerProjectCacheEntry(options.projectId, "thumbnails", cacheId, cacheRoot);
    return { cacheId, filePath: targetPath, cacheHit: true };
  }
  const result = await enqueueThumbnail(targetPath, async () => {
    if (await cachedFileReady(targetPath)) {
      return { cacheId, filePath: targetPath, cacheHit: true };
    }
    await fs.mkdir(directory, { recursive: true });
    const tempPath = path.join(directory, `${cacheId}.${crypto.randomUUID()}.jpg`);
    const ffmpeg = options.ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";
    const render = (seek) => runProcess(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-ss", seek.toFixed(3), "-i", source.absolute,
      "-frames:v", "1", "-an", "-sn",
      "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
      "-q:v", "4", "-y", tempPath
    ]);
    try {
      try {
        await render(at);
      } catch (error) {
        if (at <= 0) throw error;
        await fs.unlink(tempPath).catch(() => {});
        await render(0);
      }
      if (!await cachedFileReady(tempPath)) throw new Error("FFmpeg produced no thumbnail.");
      await fs.rename(tempPath, targetPath);
      return { cacheId, filePath: targetPath, cacheHit: false };
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
  });
  await registerProjectCacheEntry(options.projectId, "thumbnails", cacheId, cacheRoot);
  return result;
}

async function availableBytes(directory) {
  await fs.mkdir(directory, { recursive: true });
  if (typeof fs.statfs !== "function") return Number.POSITIVE_INFINITY;
  const stat = await fs.statfs(directory);
  return Number(stat.bavail) * Number(stat.bsize);
}

export async function pruneMediaCache(cacheRoot = DEFAULT_MEDIA_CACHE_ROOT, options = {}) {
  const directory = path.join(cacheRoot, "media");
  const maxBytes = Math.max(0, Number(options.maxBytes ?? DEFAULT_MAX_MEDIA_CACHE_BYTES));
  const incomingBytes = Math.max(0, Number(options.incomingBytes) || 0);
  const keepPath = options.keepPath ? path.resolve(options.keepPath) : null;
  await fs.mkdir(directory, { recursive: true });
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const fileEntries = entries.filter((entry) => entry.isFile() && !entry.name.includes(".part-"));
  const files = [];
  for (let offset = 0; offset < fileEntries.length; offset += 32) {
    const batch = await Promise.all(fileEntries.slice(offset, offset + 32).map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      const stat = await fs.stat(filePath).catch(() => null);
      return stat ? { filePath, size: stat.size, usedAt: Math.max(stat.atimeMs, stat.mtimeMs) } : null;
    }));
    files.push(...batch.filter(Boolean));
  }
  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  const targetBytes = Math.max(0, maxBytes - incomingBytes);
  const removed = [];
  for (const file of files.sort((a, b) => a.usedAt - b.usedAt)) {
    if (totalBytes <= targetBytes) break;
    if (keepPath && file.filePath === keepPath) continue;
    await fs.unlink(file.filePath).catch(() => {});
    totalBytes -= file.size;
    removed.push(file.filePath);
  }
  return { totalBytes: Math.max(0, totalBytes), removedCount: removed.length };
}

function parseFrameRate(value) {
  const [numerator, denominator] = String(value || "").split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

async function probePlaybackSource(filePath, options = {}) {
  const ffprobe = options.ffprobePath || process.env.FFPROBE_PATH || process.env.FFPROBE_BIN || "ffprobe";
  const { stdout } = await runProcessOutput(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate",
    "-of", "json",
    filePath
  ]);
  const data = JSON.parse(stdout);
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new Error("当前流畅版没有可播放的视频轨道。");
  const durationSeconds = Math.max(0, Number(data.format?.duration) || 0);
  const frameRate = parseFrameRate(video.avg_frame_rate) || parseFrameRate(video.r_frame_rate) || 30;
  return {
    durationSeconds,
    frameRate,
    width: Math.max(0, Number(video.width) || 0),
    height: Math.max(0, Number(video.height) || 0),
    hasAudio: streams.some((stream) => stream.codec_type === "audio")
  };
}

function playbackProxyOptions(options = {}) {
  const maxEdge = Math.max(480, Math.round(Number(options.maxEdge) || DEFAULT_PROXY_MAX_EDGE));
  const videoBitrate = Math.max(500_000, Math.round(Number(options.videoBitrate) || DEFAULT_PROXY_VIDEO_BITRATE));
  const audioBitrate = Math.max(64_000, Math.round(Number(options.audioBitrate) || DEFAULT_PROXY_AUDIO_BITRATE));
  const threads = Math.max(1, Math.min(8, Math.round(Number(options.threads) || DEFAULT_PROXY_THREADS)));
  return { maxEdge, videoBitrate, audioBitrate, threads };
}

function proxyProfileSignature(profile) {
  return [
    PLAYBACK_PROXY_VERSION,
    `edge-${profile.maxEdge}`,
    `video-${profile.videoBitrate}`,
    `audio-${profile.audioBitrate}`
  ].join(":");
}

function mediaJobSnapshot(job) {
  const workingPercent = job.durationSeconds > 0
    ? Math.min(99, Math.max(0, Math.round(job.processedSeconds / job.durationSeconds * 100)))
    : 0;
  const percent = job.status === "ready" ? 100 : workingPercent;
  return {
    cacheId: job.cacheId,
    kind: "playback-proxy",
    status: job.status,
    phase: job.status,
    processedSeconds: job.processedSeconds || 0,
    durationSeconds: job.durationSeconds || 0,
    bytesCopied: job.outputBytes || 0,
    totalBytes: job.outputBytes || job.estimatedBytes || job.sourceBytes || 0,
    outputBytes: job.outputBytes || 0,
    percent,
    encoder: job.encoder || null,
    maxEdge: job.profile?.maxEdge || DEFAULT_PROXY_MAX_EDGE,
    error: job.error || null,
    filePath: job.targetPath
  };
}

function proxyScaleFilter(maxEdge) {
  return `scale=w='if(gte(iw,ih),trunc(min(iw,${maxEdge})/2)*2,-2)':h='if(gte(iw,ih),-2,trunc(min(ih,${maxEdge})/2)*2)'`;
}

function proxyEncoderArgs(encoder, profile) {
  const bitrate = `${Math.round(profile.videoBitrate / 1000)}k`;
  const maxRate = `${Math.round(profile.videoBitrate * 1.2 / 1000)}k`;
  const bufferSize = `${Math.round(profile.videoBitrate * 2.4 / 1000)}k`;
  if (encoder === "h264_videotoolbox") {
    return [
      "-c:v", encoder,
      "-b:v", bitrate,
      "-maxrate", maxRate,
      "-bufsize", bufferSize,
      "-profile:v", "high",
      "-realtime", "1",
      "-prio_speed", "1",
      "-allow_sw", "1"
    ];
  }
  return [
    "-c:v", encoder,
    "-preset", "veryfast",
    "-crf", "24",
    "-maxrate", maxRate,
    "-bufsize", bufferSize,
    "-profile:v", "high",
    "-threads", String(profile.threads)
  ];
}

function proxyFfmpegArgs(job, info, encoder, tempPath, options = {}) {
  const ffmpegAudioBitrate = `${Math.round(job.profile.audioBitrate / 1000)}k`;
  const gop = Math.max(24, Math.min(120, Math.round(info.frameRate * 2)));
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-i", job.sourcePath,
    "-map", "0:v:0", "-map", "0:a:0?",
    "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
    "-vf", proxyScaleFilter(job.profile.maxEdge),
    ...proxyEncoderArgs(encoder, job.profile),
    "-pix_fmt", "yuv420p",
    "-g", String(gop), "-keyint_min", String(Math.max(12, Math.round(gop / 2))),
    "-sc_threshold", "0",
    "-c:a", options.audioEncoder || "aac", "-b:a", ffmpegAudioBitrate, "-ar", "48000",
    "-movflags", "+faststart", "-avoid_negative_ts", "make_zero",
    "-max_muxing_queue_size", "2048",
    "-progress", "pipe:1", "-nostats",
    "-y", tempPath
  ];
}

function proxyEncoderCandidates(options = {}) {
  const requested = options.videoEncoder || process.env.STORYCUT_PROXY_ENCODER;
  if (requested) return [requested];
  return process.platform === "darwin"
    ? ["h264_videotoolbox", "libx264"]
    : ["libx264"];
}

async function createPlaybackProxy(job, options) {
  const directory = path.dirname(job.targetPath);
  const ffmpeg = options.ffmpegPath || process.env.FFMPEG_PATH || process.env.FFMPEG_BIN || "ffmpeg";
  let tempPath = "";
  try {
    await fs.mkdir(directory, { recursive: true });
    job.status = "probing";
    const info = await probePlaybackSource(job.sourcePath, options);
    job.durationSeconds = info.durationSeconds;
    job.estimatedBytes = info.durationSeconds > 0
      ? Math.ceil(info.durationSeconds * (job.profile.videoBitrate + (info.hasAudio ? job.profile.audioBitrate : 0)) / 8 * 1.15)
      : Math.max(job.sourceBytes, 64 * 1024 * 1024);
    const freeBytes = await availableBytes(directory);
    const reserveBytes = Math.max(0, Number(options.reserveBytes ?? DEFAULT_FREE_SPACE_RESERVE_BYTES));
    if (freeBytes < job.estimatedBytes + reserveBytes) {
      throw new Error("本机 SSD 可用空间不足，无法生成播放代理。请清理磁盘后重试。");
    }
    await pruneMediaCache(options.cacheRoot, {
      maxBytes: options.maxBytes,
      incomingBytes: job.estimatedBytes,
      keepPath: job.targetPath
    });

    let lastError = null;
    for (const encoder of proxyEncoderCandidates(options)) {
      tempPath = `${job.targetPath}.part-${crypto.randomUUID()}.mp4`;
      job.encoder = encoder;
      job.processedSeconds = 0;
      job.status = "transcoding";
      try {
        await runProcessProgress(
          ffmpeg,
          proxyFfmpegArgs(job, info, encoder, tempPath, options),
          (seconds) => { job.processedSeconds = Math.max(job.processedSeconds, seconds); }
        );
        if (!await cachedFileReady(tempPath)) throw new Error("FFmpeg 没有生成播放代理。");
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await fs.unlink(tempPath).catch(() => {});
        tempPath = "";
      }
    }
    if (lastError) throw lastError;

    job.status = "finalizing";
    await fs.rename(tempPath, job.targetPath);
    tempPath = "";
    const output = await fs.stat(job.targetPath);
    job.outputBytes = output.size;
    job.processedSeconds = job.durationSeconds;
    job.status = "ready";
    job.completedAt = Date.now();
    await Promise.all([...job.projectIds].map((projectId) => (
      registerProjectCacheEntry(projectId, "media", job.cacheId, options.cacheRoot)
    )));
    await pruneMediaCache(options.cacheRoot, {
      maxBytes: options.maxBytes,
      keepPath: job.targetPath
    });
  } catch (error) {
    if (tempPath) await fs.unlink(tempPath).catch(() => {});
    job.status = "error";
    job.error = error instanceof Error ? error.message : "无法生成播放代理。";
  }
}

function pumpProxyQueue() {
  while (activeProxyWorkers < MAX_PROXY_WORKERS && proxyQueue.length) {
    const entry = proxyQueue.shift();
    activeProxyWorkers += 1;
    void createPlaybackProxy(entry.job, entry.options).finally(() => {
      activeProxyWorkers -= 1;
      pumpProxyQueue();
    });
  }
}

export async function beginPlaybackProxy(filePath, options = {}) {
  const cacheRoot = options.cacheRoot || DEFAULT_MEDIA_CACHE_ROOT;
  const source = await sourceIdentity(filePath);
  const profile = playbackProxyOptions(options);
  const cacheId = hash(`${source.id}\0${proxyProfileSignature(profile)}`);
  const targetPath = path.join(cacheRoot, "media", `${cacheId}.mp4`);
  if (await cachedFileReady(targetPath)) {
    const stat = await fs.stat(targetPath);
    await fs.utimes(targetPath, new Date(), stat.mtime).catch(() => {});
    await registerProjectCacheEntry(options.projectId, "media", cacheId, cacheRoot);
    return mediaJobSnapshot({
      cacheId,
      status: "ready",
      sourceBytes: source.stat.size,
      outputBytes: stat.size,
      processedSeconds: 0,
      durationSeconds: 0,
      profile,
      targetPath
    });
  }
  const jobKey = targetPath;
  let existing = mediaProxyJobs.get(jobKey);
  if (existing?.status === "ready") {
    mediaProxyJobs.delete(jobKey);
    existing = null;
  }
  if (existing && validProjectId(options.projectId)) existing.projectIds.add(options.projectId);
  if (existing && !(options.retry && existing.status === "error")) return mediaJobSnapshot(existing);
  if (existing) mediaProxyJobs.delete(jobKey);
  const job = {
    cacheId,
    status: "queued",
    sourceBytes: source.stat.size,
    outputBytes: 0,
    estimatedBytes: 0,
    processedSeconds: 0,
    durationSeconds: 0,
    sourcePath: source.absolute,
    targetPath,
    profile,
    projectIds: new Set(validProjectId(options.projectId) ? [options.projectId] : []),
    error: null,
    encoder: null
  };
  mediaProxyJobs.set(jobKey, job);
  proxyQueue.push({
    job,
    options: {
      ...options,
      cacheRoot,
      maxBytes: options.maxBytes ?? (await mediaCacheSettings(cacheRoot)).mediaMaxBytes
    }
  });
  pumpProxyQueue();
  return mediaJobSnapshot(job);
}

export async function resolvePlaybackProxyFile(fileId, cacheRoot = DEFAULT_MEDIA_CACHE_ROOT) {
  const match = String(fileId || "").match(/^proxy-([a-f0-9]{24})$/);
  if (!match) return null;
  const filePath = path.join(cacheRoot, "media", `${match[1]}.mp4`);
  return await cachedFileReady(filePath) ? filePath : null;
}

export async function waitForPlaybackProxy(filePath, options = {}) {
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 30_000);
  const startedAt = Date.now();
  let status = await beginPlaybackProxy(filePath, options);
  while (!["ready", "error"].includes(status.status) && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = await beginPlaybackProxy(filePath, options);
  }
  return status;
}

async function cacheDirectoryStatus(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const fileEntries = entries.filter((entry) => entry.isFile());
  const files = [];
  for (let offset = 0; offset < fileEntries.length; offset += 32) {
    const batch = await Promise.all(fileEntries.slice(offset, offset + 32).map(async (entry) => {
      const stat = await fs.stat(path.join(directory, entry.name)).catch(() => null);
      return stat ? { name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs } : null;
    }));
    files.push(...batch.filter(Boolean));
  }
  return {
    count: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
    partialCount: files.filter((file) => file.name.includes(".part-")).length,
    updatedAt: files.reduce((latest, file) => Math.max(latest, file.mtimeMs), 0)
  };
}

async function projectCacheSectionStatus(projectId, section, cacheRoot) {
  const manifest = await readProjectCacheManifest(projectId, cacheRoot);
  if (!manifest) return { count: 0, bytes: 0, updatedAt: 0 };
  const extension = section === "media" ? ".mp4" : ".jpg";
  const directory = path.join(cacheRoot, section);
  const valid = [];
  const files = [];
  for (let offset = 0; offset < manifest[section].length; offset += 32) {
    const cacheIds = manifest[section].slice(offset, offset + 32);
    const batch = await Promise.all(cacheIds.map(async (cacheId) => {
      const stat = await fs.stat(path.join(directory, `${cacheId}${extension}`)).catch(() => null);
      return stat?.isFile() ? { cacheId, size: stat.size, mtimeMs: stat.mtimeMs } : null;
    }));
    for (const file of batch.filter(Boolean)) {
      valid.push(file.cacheId);
      files.push(file);
    }
  }
  if (valid.length !== manifest[section].length) {
    const stale = new Set(manifest[section].filter((cacheId) => !valid.includes(cacheId)));
    await withProjectManifestLock(projectId, cacheRoot, async () => {
      const latest = await readProjectCacheManifest(projectId, cacheRoot);
      latest[section] = latest[section].filter((cacheId) => !stale.has(cacheId));
      await writeProjectCacheManifest(latest, cacheRoot);
    });
  }
  return {
    count: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
    updatedAt: files.reduce((latest, file) => Math.max(latest, file.mtimeMs), 0)
  };
}

export async function projectMediaCacheStatus(projectId, cacheRoot = DEFAULT_MEDIA_CACHE_ROOT) {
  const safeProjectId = validProjectId(projectId);
  if (!safeProjectId) return null;
  const [media, thumbnails] = await Promise.all([
    projectCacheSectionStatus(safeProjectId, "media", cacheRoot),
    projectCacheSectionStatus(safeProjectId, "thumbnails", cacheRoot)
  ]);
  return { projectId: safeProjectId, media, thumbnails, totalBytes: media.bytes + thumbnails.bytes };
}

async function otherProjectCacheReferences(projectId, section, cacheRoot) {
  const directory = projectCacheDirectory(cacheRoot);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const references = new Set();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === `${projectId}.json`) continue;
    const otherId = entry.name.slice(0, -5);
    const manifest = await readProjectCacheManifest(otherId, cacheRoot);
    for (const cacheId of manifest?.[section] || []) references.add(cacheId);
  }
  return references;
}

export async function clearProjectMediaCache(projectId, section = "all", cacheRoot = DEFAULT_MEDIA_CACHE_ROOT) {
  const safeProjectId = validProjectId(projectId);
  if (!safeProjectId) throw new Error("Invalid StoryCut project cache id.");
  const sections = section === "all" ? ["media", "thumbnails"] : [section];
  if (sections.some((item) => !new Set(["media", "thumbnails"]).has(item))) {
    throw new Error("Unknown StoryCut cache section.");
  }
  if (sections.includes("media") && (activeProxyWorkers > 0 || proxyQueue.length > 0)) {
    throw new Error("播放代理仍在生成，请完成后再清理。");
  }
  if (sections.includes("thumbnails") && (activeThumbnailWorkers > 0 || thumbnailQueue.length > 0)) {
    throw new Error("首帧缩略图仍在生成，请稍后再清理。");
  }
  const removed = {};
  await withProjectManifestLock(safeProjectId, cacheRoot, async () => {
    const manifest = await readProjectCacheManifest(safeProjectId, cacheRoot);
    for (const target of sections) {
      const extension = target === "media" ? ".mp4" : ".jpg";
      const otherReferences = await otherProjectCacheReferences(safeProjectId, target, cacheRoot);
      let removedCount = 0;
      let removedBytes = 0;
      for (const cacheId of manifest[target]) {
        if (otherReferences.has(cacheId)) continue;
        const filePath = path.join(cacheRoot, target, `${cacheId}${extension}`);
        const stat = await fs.stat(filePath).catch(() => null);
        if (stat?.isFile()) {
          await fs.unlink(filePath).catch(() => {});
          removedCount += 1;
          removedBytes += stat.size;
        }
      }
      removed[target] = { removedCount, removedBytes, detachedCount: manifest[target].length };
      manifest[target] = [];
    }
    await writeProjectCacheManifest(manifest, cacheRoot);
  });
  return removed;
}

async function clearProjectOwnershipSection(section, cacheRoot) {
  const directory = projectCacheDirectory(cacheRoot);
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const projectId = entry.name.slice(0, -5);
    if (!validProjectId(projectId)) continue;
    await withProjectManifestLock(projectId, cacheRoot, async () => {
      const manifest = await readProjectCacheManifest(projectId, cacheRoot);
      manifest[section] = [];
      await writeProjectCacheManifest(manifest, cacheRoot);
    });
  }
}

export async function mediaCacheStatus(cacheRoot = DEFAULT_MEDIA_CACHE_ROOT, options = {}) {
  const [media, thumbnails, settings, currentProject] = await Promise.all([
    cacheDirectoryStatus(path.join(cacheRoot, "media")),
    cacheDirectoryStatus(path.join(cacheRoot, "thumbnails")),
    mediaCacheSettings(cacheRoot),
    options.projectId ? projectMediaCacheStatus(options.projectId, cacheRoot) : null
  ]);
  return {
    cacheRoot,
    media,
    thumbnails,
    settings,
    currentProject,
    jobs: {
      proxyActive: activeProxyWorkers,
      proxyQueued: proxyQueue.length,
      thumbnailActive: activeThumbnailWorkers,
      thumbnailQueued: thumbnailQueue.length
    }
  };
}

export async function clearMediaCacheSection(section, cacheRoot = DEFAULT_MEDIA_CACHE_ROOT) {
  if (!new Set(["media", "thumbnails"]).has(section)) throw new Error("Unknown StoryCut cache section.");
  if (section === "media" && (activeProxyWorkers > 0 || proxyQueue.length > 0)) {
    throw new Error("播放代理仍在生成，请完成后再清理。");
  }
  if (section === "thumbnails" && (activeThumbnailWorkers > 0 || thumbnailQueue.length > 0)) {
    throw new Error("首帧缩略图仍在生成，请稍后再清理。");
  }
  const directory = path.join(cacheRoot, section);
  const before = await cacheDirectoryStatus(directory);
  await fs.rm(directory, { recursive: true, force: true });
  await clearProjectOwnershipSection(section, cacheRoot);
  if (section === "media") {
    for (const [key, job] of mediaProxyJobs) {
      if (["ready", "error"].includes(job.status)) mediaProxyJobs.delete(key);
    }
  }
  return { removedCount: before.count, removedBytes: before.bytes };
}

// Backwards-compatible exports for callers created before playback proxies
// replaced byte-for-byte SSD copies.
export const beginMediaCache = beginPlaybackProxy;
export const waitForMediaCache = waitForPlaybackProxy;

export function playbackProxyLocationLabel() {
  return "~/Library/Caches/StoryCut/media（播放代理）";
}

export const mediaCacheLocationLabel = playbackProxyLocationLabel;
