import http from "node:http";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { analyzeLocally, normalizeDecisions } from "./src/analyze.mjs";
import {
  analyzeTranscript,
  timecodedTranscriptToAnalyzeInput
} from "./src/adapter.mjs";
import {
  ensureDirs,
  findUpload,
  ffprobe,
  newFileId,
  safeExtension,
  transcriptsDir,
  uploadPathFor,
} from "./src/upload-store.mjs";
import { readHealth } from "./src/health.mjs";
import {
  buildReviewTimeline,
  readProjectDocument,
  saveReview,
  saveSubtitleCorrection
} from "./src/project-workspace.mjs";
import {
  clearProjectIndexCache,
  clearProjectIndexCacheFor,
  inspectProjectIndexed,
  projectIndexCacheStatus,
  projectIndexCacheStatusFor,
  projectSessionId,
  restoreProjectIndexed
} from "./src/project-index.mjs";
import {
  applyEditProposal,
  buildEditWorkspace,
  proposeEdit,
  saveEditPreview,
  undoLastEdit
} from "./src/edit-workspace.mjs";
import { compareEditWorkspaces } from "./src/edit-compare.mjs";
import {
  DEFAULT_MEDIA_CACHE_ROOT,
  beginPlaybackProxy,
  clearMediaCacheSection,
  clearProjectMediaCache,
  getFirstFrameThumbnail,
  mediaCacheStatus,
  playbackProxyLocationLabel,
  resolvePlaybackProxyFile,
  updateMediaCacheSettings
} from "./src/media-cache.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const transcribeScript = path.join(root, "tools", "transcribe.py");
const port = Number(process.env.PORT || 4173);
const maxBodyBytes = 200_000;
// Per FR-1.5: 500 MB default cap for media uploads. Analyze body stays at 200 KB.
const maxUploadBytes = Number(process.env.STORYCUT_MAX_UPLOAD_BYTES || 500 * 1024 * 1024);
const projectSessions = new Map();
const MAX_PROJECT_SESSIONS = 12;
const PROJECT_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

function rememberProjectSession(projectId, inspection) {
  inspection.sessionAccessedAt = Date.now();
  projectSessions.delete(projectId);
  projectSessions.set(projectId, inspection);
  while (projectSessions.size > MAX_PROJECT_SESSIONS) {
    projectSessions.delete(projectSessions.keys().next().value);
  }
  return inspection;
}

async function projectSession(projectId) {
  const key = String(projectId || "");
  let session = projectSessions.get(key);
  if (session && Date.now() - Number(session.sessionAccessedAt || 0) > PROJECT_SESSION_TTL_MS) {
    projectSessions.delete(key);
    session = null;
  }
  if (!session) {
    session = await restoreProjectIndexed(key).catch(() => null);
    if (session) rememberProjectSession(key, session);
  }
  if (!session) return null;
  return rememberProjectSession(key, session);
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

const responseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "decisions"],
  properties: {
    summary: { type: "string" },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "start", "end", "text", "action", "reason", "confidence"],
        properties: {
          id: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
          text: { type: "string" },
          action: { type: "string", enum: ["KEEP", "CUT", "MOVE", "B-ROLL"] },
          reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        }
      }
    }
  }
};

function headers(type = "text/plain; charset=utf-8") {
  return {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  };
}

function json(res, status, payload) {
  res.writeHead(status, headers(mime[".json"]));
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("Input is too large. Limit: 200 KB.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new Error("The model returned no structured output.");
}

async function analyzeWithOpenAI(transcript) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.OPENAI_MODEL || "gpt-5.6-terra";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: "medium" },
      input: [
        {
          role: "system",
          content: [{
            type: "input_text",
            text: "You are StoryCut, an explainable rough-cut editor. Analyze only the supplied transcript. Return concise editorial proposals. KEEP essential ideas, CUT errors or repetition, MOVE a strong hook that appears too late, and use B-ROLL only when a concrete visual would improve clarity. Never infer personal facts. Never reproduce secrets."
          }]
        },
        {
          role: "user",
          content: [{ type: "input_text", text: transcript.slice(0, 30_000) }]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "storycut_decisions",
          strict: true,
          schema: responseSchema
        }
      }
    })
  });
  if (!response.ok) {
    const safeMessage = response.status === 401
      ? "OpenAI authentication failed. Check the server-side API key."
      : `OpenAI request failed with status ${response.status}.`;
    throw new Error(safeMessage);
  }
  const payload = await response.json();
  return normalizeDecisions(JSON.parse(extractOutputText(payload)));
}

async function serveStatic(req, res) {
  const requestPath = new URL(req.url, `http://${req.headers.host}`).pathname;
  const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) {
    res.writeHead(403, headers());
    return res.end("Forbidden");
  }
  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, headers(mime[path.extname(filePath)] || "application/octet-stream"));
    res.end(data);
  } catch {
    res.writeHead(404, headers());
    res.end("Not found");
  }
}

async function getProjectFile(url) {
  const projectId = url.searchParams.get("projectId") || "";
  const fileId = url.searchParams.get("fileId") || "";
  const session = await projectSession(projectId);
  let filePath = session?.fileMap.get(fileId);
  if (session && !filePath && fileId.startsWith("proxy-")) {
    filePath = await resolvePlaybackProxyFile(fileId);
    if (filePath) session.fileMap.set(fileId, filePath);
  }
  if (!session || !filePath) return null;
  return { session, filePath };
}

function pipeProjectFile(req, res, filePath, options = undefined) {
  const stream = createReadStream(filePath, options);
  const stopReading = () => {
    if (!stream.destroyed) stream.destroy();
  };
  req.once("aborted", stopReading);
  res.once("close", stopReading);
  stream.once("error", () => {
    if (!res.writableEnded) res.destroy();
  });
  stream.pipe(res);
  return stream;
}

async function serveLocalFile(req, res, filePath, options = {}) {
  const stat = await fs.stat(filePath);
  const type = options.type || mime[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const baseHeaders = {
    ...headers(type),
    "Cache-Control": options.cacheControl || "private, max-age=3600",
    "Accept-Ranges": "bytes",
    "ETag": etag,
    "Last-Modified": stat.mtime.toUTCString(),
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(options.filename || path.basename(filePath))}`
  };
  const range = req.headers.range;
  if (!range) {
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, baseHeaders);
      return res.end();
    }
    res.writeHead(200, { ...baseHeaders, "Content-Length": stat.size });
    return pipeProjectFile(req, res, filePath);
  }
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${stat.size}` });
    return res.end();
  }
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
    res.writeHead(416, { ...baseHeaders, "Content-Range": `bytes */${stat.size}` });
    return res.end();
  }
  res.writeHead(206, {
    ...baseHeaders,
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${stat.size}`
  });
  return pipeProjectFile(req, res, filePath, { start, end });
}

async function serveProjectFile(req, res, url) {
  const target = await getProjectFile(url);
  if (!target) return json(res, 404, { error: "Project file is no longer available. Reopen the project." });
  return serveLocalFile(req, res, target.filePath);
}

async function serveProjectThumbnail(req, res, url) {
  const target = await getProjectFile(url);
  if (!target) return json(res, 404, { error: "Project file is no longer available. Reopen the project." });
  const requestedAt = Number(url.searchParams.get("at") || 0.05);
  if (!Number.isFinite(requestedAt) || requestedAt < 0 || requestedAt > 24 * 60 * 60) {
    return json(res, 400, { error: "Invalid thumbnail time." });
  }
  const projectId = url.searchParams.get("projectId") || "";
  const thumbnail = await getFirstFrameThumbnail(target.filePath, { at: requestedAt, projectId });
  return serveLocalFile(req, res, thumbnail.filePath, {
    type: mime[".jpg"],
    filename: `${path.parse(target.filePath).name}-frame.jpg`,
    cacheControl: "private, max-age=31536000, immutable"
  });
}

async function openProject(req, res) {
  const body = await readJson(req);
  const inspection = await inspectProjectIndexed(body.path, { refresh: body.refresh === true });
  const projectId = projectSessionId(inspection.projectRoot);
  rememberProjectSession(projectId, inspection);
  return json(res, 200, {
    projectId,
    projectPath: inspection.projectRoot,
    editPath: inspection.editRoot,
    index: inspection.index,
    ...inspection.project
  });
}

async function serveProjectDocument(res, url) {
  const target = await getProjectFile(url);
  if (!target) return json(res, 404, { error: "Project document is no longer available. Reopen the project." });
  const content = await readProjectDocument(target.filePath);
  return json(res, 200, { content });
}

async function handleReview(req, res) {
  const body = await readJson(req);
  const projectId = String(body.projectId || "");
  const session = await projectSession(projectId);
  if (!session) return json(res, 404, { error: "Project session expired. Reopen the project." });
  const result = await saveReview(session.editRoot, body);
  const refreshed = await inspectProjectIndexed(session.projectRoot, { refresh: true });
  rememberProjectSession(projectId, refreshed);
  return json(res, 201, {
    ...result,
    project: {
      projectId,
      projectPath: refreshed.projectRoot,
      editPath: refreshed.editRoot,
      ...refreshed.project
    }
  });
}

async function serveReviewTimeline(res, url) {
  const projectId = url.searchParams.get("projectId") || "";
  const session = await projectSession(projectId);
  if (!session) return json(res, 404, { error: "Project session expired. Reopen the project." });
  return json(res, 200, await buildReviewTimeline(session));
}

async function handleSubtitleCorrection(req, res) {
  const body = await readJson(req);
  const projectId = String(body.projectId || "");
  const session = await projectSession(projectId);
  if (!session) return json(res, 404, { error: "Project session expired. Reopen the project." });
  const result = await saveSubtitleCorrection(session.editRoot, body);
  const refreshed = await inspectProjectIndexed(session.projectRoot, { refresh: true });
  rememberProjectSession(projectId, refreshed);
  return json(res, 201, {
    ...result,
    timeline: await buildReviewTimeline(refreshed)
  });
}

async function projectSessionOrError(res, projectId) {
  const session = await projectSession(projectId);
  if (!session) {
    json(res, 404, { error: "Project session expired. Reopen the project." });
    return null;
  }
  return session;
}

async function serveEditWorkspace(res, url) {
  const session = await projectSessionOrError(res, url.searchParams.get("projectId"));
  if (!session) return;
  const versionId = url.searchParams.get("versionId") || undefined;
  return json(res, 200, await buildEditWorkspace(session, { versionId }));
}

async function serveEditComparison(res, url) {
  const session = await projectSessionOrError(res, url.searchParams.get("projectId"));
  if (!session) return;
  const aVersionId = String(url.searchParams.get("aVersionId") || "");
  const bVersionId = String(url.searchParams.get("bVersionId") || "");
  if (!aVersionId || !bVersionId || aVersionId === bVersionId) {
    return json(res, 400, { error: "Choose two different StoryCut review versions." });
  }
  const [aWorkspace, bWorkspace] = await Promise.all([
    buildEditWorkspace(session, { versionId: aVersionId }),
    buildEditWorkspace(session, { versionId: bVersionId })
  ]);
  return json(res, 200, { comparison: compareEditWorkspaces(bWorkspace, aWorkspace) });
}

async function handleProjectPlaybackProxy(req, res) {
  const body = await readJson(req);
  const session = await projectSessionOrError(res, body.projectId);
  if (!session) return;
  const sourcePath = session.fileMap.get(String(body.fileId || ""));
  if (!sourcePath) return json(res, 404, { error: "Project media is no longer available. Reopen the project." });
  const extension = path.extname(sourcePath).toLowerCase();
  if (![".mp4", ".mov", ".m4v", ".webm"].includes(extension)) {
    return json(res, 400, { error: "Only playable video previews can be converted into playback proxies." });
  }
  const result = await beginPlaybackProxy(sourcePath, { retry: body.retry === true, projectId: body.projectId });
  const proxyFileId = `proxy-${result.cacheId}`;
  if (result.status === "ready") session.fileMap.set(proxyFileId, result.filePath);
  return json(res, 200, {
    kind: result.kind,
    status: result.status,
    phase: result.phase,
    proxyFileId: result.status === "ready" ? proxyFileId : null,
    cacheFileId: result.status === "ready" ? proxyFileId : null,
    bytesCopied: result.bytesCopied,
    totalBytes: result.totalBytes,
    outputBytes: result.outputBytes,
    processedSeconds: result.processedSeconds,
    durationSeconds: result.durationSeconds,
    percent: result.percent,
    encoder: result.encoder,
    maxEdge: result.maxEdge,
    error: result.error,
    cacheLocation: playbackProxyLocationLabel()
  });
}

async function serveCacheStatus(res, url) {
  const projectId = String(url.searchParams.get("projectId") || "");
  if (projectId && !await projectSession(projectId)) {
    return json(res, 404, { error: "Project session expired. Reopen the project." });
  }
  const [media, projectIndex] = await Promise.all([
    mediaCacheStatus(undefined, { projectId: projectId || undefined }),
    projectIndexCacheStatus()
  ]);
  const currentProjectIndex = projectId ? await projectIndexCacheStatusFor(projectId) : null;
  const currentProject = media.currentProject
    ? {
        ...media.currentProject,
        projectIndex: currentProjectIndex,
        totalBytes: media.currentProject.totalBytes + Number(currentProjectIndex?.bytes || 0)
      }
    : null;
  return json(res, 200, {
    media: media.media,
    thumbnails: media.thumbnails,
    projectIndex,
    currentProject,
    settings: media.settings,
    jobs: media.jobs,
    location: "~/Library/Caches/StoryCut"
  });
}

async function handleCacheClear(req, res) {
  const body = await readJson(req);
  const target = String(body.target || "");
  const scope = body.scope === "project" ? "project" : "global";
  if (!["media", "thumbnails", "project-index", "all"].includes(target)) {
    return json(res, 400, { error: "Unknown StoryCut cache target." });
  }
  const removed = {};
  if (scope === "project") {
    const projectId = String(body.projectId || "");
    if (!await projectSession(projectId)) return json(res, 404, { error: "Project session expired. Reopen the project." });
    if (target === "media" || target === "all") Object.assign(removed, await clearProjectMediaCache(projectId, "media"));
    if (target === "thumbnails" || target === "all") Object.assign(removed, await clearProjectMediaCache(projectId, "thumbnails"));
    if (target === "project-index" || target === "all") removed.projectIndex = await clearProjectIndexCacheFor(projectId);
  } else {
    if (target === "media" || target === "all") removed.media = await clearMediaCacheSection("media");
    if (target === "thumbnails" || target === "all") removed.thumbnails = await clearMediaCacheSection("thumbnails");
    if (target === "project-index" || target === "all") removed.projectIndex = await clearProjectIndexCache();
  }
  return json(res, 200, { removed, scope });
}

async function handleCacheSettings(req, res) {
  const body = await readJson(req);
  const settings = await updateMediaCacheSettings(body.mediaMaxBytes);
  return json(res, 200, { settings });
}

async function handleCacheOpen(res) {
  if (process.platform !== "darwin") return json(res, 501, { error: "打开缓存目录目前只支持 macOS。" });
  await fs.mkdir(DEFAULT_MEDIA_CACHE_ROOT, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [DEFAULT_MEDIA_CACHE_ROOT], { detached: true, stdio: "ignore" });
    child.once("spawn", resolve);
    child.once("error", reject);
    child.unref();
  });
  return json(res, 200, { opened: true, location: "~/Library/Caches/StoryCut" });
}

async function handleEditProposal(req, res) {
  const body = await readJson(req);
  const session = await projectSessionOrError(res, body.projectId);
  if (!session) return;
  const workspace = await buildEditWorkspace(session);
  const proposal = proposeEdit(workspace, body);
  return json(res, 200, { proposal });
}

async function handleEditApply(req, res) {
  const body = await readJson(req);
  const session = await projectSessionOrError(res, body.projectId);
  if (!session) return;
  const result = await applyEditProposal(session, body.proposal);
  return json(res, 201, result);
}

async function handleEditPreview(req, res) {
  const body = await readJson(req);
  const session = await projectSessionOrError(res, body.projectId);
  if (!session) return;
  return json(res, 201, await saveEditPreview(session, body.proposal));
}

async function handleEditUndo(req, res) {
  const body = await readJson(req);
  const session = await projectSessionOrError(res, body.projectId);
  if (!session) return;
  return json(res, 200, await undoLastEdit(session));
}

async function readRawBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`Upload exceeds ${limit} bytes.`);
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks), size };
}

async function handleUpload(req, res) {
  const filename = String(req.headers["x-filename"] || "");
  const ext = safeExtension(filename);
  if (!ext) {
    return json(res, 400, {
      error: "Unsupported file type. Expected one of: mp4, mov, m4a, wav, mp3."
    });
  }
  await ensureDirs();
  const fileId = newFileId();
  const uploadPath = uploadPathFor(fileId, filename);
  let size;
  try {
    const body = await readRawBody(req, maxUploadBytes);
    size = body.size;
    await fs.writeFile(uploadPath, body.buffer);
  } catch (error) {
    if (error instanceof Error && /Upload exceeds/.test(error.message)) {
      return json(res, 413, { error: error.message });
    }
    throw error;
  }
  let probe;
  try {
    probe = await ffprobe(uploadPath);
  } catch (error) {
    await fs.unlink(uploadPath).catch(() => {});
    return json(res, 400, {
      error: `ffprobe failed: ${error instanceof Error ? error.message : "unknown"}`
    });
  }
  return json(res, 200, {
    fileId,
    filename,
    extension: ext.replace(/^\./, ""),
    sizeBytes: size,
    ...probe
  });
}

function streamTranscription(req, res, fileId, language) {
  // Sentinel error helper for an already-open SSE stream.
  const sseError = (message) => {
    if (res.writableEnded) return;
    res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
    res.end();
  };

  const args = [
    transcribeScript,
    "--input", fileId.path,
    "--language", language,
    "--model", process.env.STORYCUT_WHISPER_MODEL || "mlx-community/whisper-small-mlx",
    "--output-dir", fileId.transcriptsDir
  ];
  const child = spawn("python3", args, { stdio: ["ignore", "pipe", "pipe"] });
  req.socket.setNoDelay(true);

  res.writeHead(200, {
    ...headers("text/event-stream; charset=utf-8"),
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    let nl;
    while ((nl = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      res.write(`data: ${line}\n\n`);
    }
  });

  child.stderr.on("data", (chunk) => {
    const msg = chunk.toString("utf8").trim();
    if (!msg || res.writableEnded) return;
    res.write(`event: log\ndata: ${JSON.stringify({ message: msg })}\n\n`);
  });

  child.on("error", (error) => {
    sseError(`Failed to start transcriber: ${error.message}`);
  });

  child.on("close", (code) => {
    if (stdoutBuffer && !res.writableEnded) {
      res.write(`data: ${stdoutBuffer}\n\n`);
      stdoutBuffer = "";
    }
    if (res.writableEnded) return;
    if (code === 0) {
      res.write("event: end\ndata: ok\n\n");
    } else {
      res.write(`event: error\ndata: ${JSON.stringify({ error: `Transcriber exited with code ${code}.` })}\n\n`);
    }
    res.end();
  });

  // If the client aborts (browser tab closed), kill the model to free memory.
  req.on("close", () => {
    if (!child.killed) child.kill("SIGTERM");
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "GET" && req.url === "/api/status") {
      return json(res, 200, {
        aiAvailable: Boolean(process.env.OPENAI_API_KEY),
        mode: process.env.OPENAI_API_KEY ? "AI + local fallback" : "Local demo"
      });
    }
    if (req.method === "GET" && req.url === "/api/health") {
      return json(res, 200, await readHealth());
    }
    if (req.method === "POST" && req.url === "/api/upload") {
      return handleUpload(req, res);
    }
    if (req.method === "POST" && req.url === "/api/transcribe") {
      const body = await readJson(req);
      const fileId = String(body.fileId || "");
      const language = String(body.language || "auto");
      const uploadPath = await findUpload(fileId);
      if (!uploadPath) return json(res, 404, { error: "Unknown fileId. Upload first." });
      return streamTranscription(req, res, { path: uploadPath, transcriptsDir }, language);
    }
    if (req.method === "POST" && req.url === "/api/analyze") {
      const body = await readJson(req);
      const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
      if (transcript.length < 20) return json(res, 400, { error: "Add a longer transcript before analyzing." });
      if (transcript.length > 30_000) return json(res, 400, { error: "Transcript limit: 30,000 characters." });
      const requestedMode = body.mode === "ai" ? "ai" : "local";
      let result;
      let mode = "local";
      if (requestedMode === "ai" && process.env.OPENAI_API_KEY) {
        result = await analyzeWithOpenAI(transcript);
        mode = "ai";
      } else {
        result = analyzeLocally(transcript);
      }
      return json(res, 200, { ...result, mode });
    }
    if (req.method === "POST" && req.url === "/api/analyze-transcript") {
      const body = await readJson(req);
      const transcript = body.transcript;
      if (!transcript || !Array.isArray(transcript.segments)) {
        return json(res, 400, { error: "Expected `transcript` with a `segments` array." });
      }
      if (transcript.segments.length > 80) {
        return json(res, 413, { error: "Transcript exceeds 80 segments. Split into shorter cuts." });
      }
      const requestedMode = body.mode === "ai" ? "ai" : "local";
      let result;
      let mode = "local";
      if (requestedMode === "ai" && process.env.OPENAI_API_KEY) {
        result = await analyzeWithOpenAI(timecodedTranscriptToAnalyzeInput(transcript));
        mode = "ai";
      } else {
        result = analyzeTranscript(transcript);
      }
      return json(res, 200, { ...result, mode });
    }
    if (req.method === "POST" && url.pathname === "/api/projects/open") {
      return await openProject(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/projects/file") {
      return serveProjectFile(req, res, url);
    }
    if (req.method === "GET" && url.pathname === "/api/projects/thumbnail") {
      return serveProjectThumbnail(req, res, url);
    }
    if (req.method === "POST" && (url.pathname === "/api/projects/playback-proxy" || url.pathname === "/api/projects/media-cache")) {
      return await handleProjectPlaybackProxy(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/cache/status") {
      return await serveCacheStatus(res, url);
    }
    if (req.method === "POST" && url.pathname === "/api/cache/clear") {
      return await handleCacheClear(req, res);
    }
    if (req.method === "PATCH" && url.pathname === "/api/cache/settings") {
      return await handleCacheSettings(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/cache/open") {
      return await handleCacheOpen(res);
    }
    if (req.method === "GET" && url.pathname === "/api/projects/document") {
      return await serveProjectDocument(res, url);
    }
    if (req.method === "POST" && url.pathname === "/api/reviews") {
      return await handleReview(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/reviews/timeline") {
      return await serveReviewTimeline(res, url);
    }
    if (req.method === "POST" && url.pathname === "/api/reviews/subtitle-corrections") {
      return await handleSubtitleCorrection(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/edit/workspace") {
      return await serveEditWorkspace(res, url);
    }
    if (req.method === "GET" && url.pathname === "/api/edit/compare") {
      return await serveEditComparison(res, url);
    }
    if (req.method === "POST" && url.pathname === "/api/edit/propose") {
      return await handleEditProposal(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/edit/apply") {
      return await handleEditApply(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/edit/preview") {
      return await handleEditPreview(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/edit/undo") {
      return await handleEditUndo(req, res);
    }
    if (req.method === "GET") return serveStatic(req, res);
    res.writeHead(405, headers());
    res.end("Method not allowed");
  } catch (error) {
    // Headers may already be sent for the SSE path — fall back to plain 500.
    if (!res.headersSent) {
      return json(res, 500, { error: error instanceof Error ? error.message : "Unexpected error" });
    }
    if (!res.writableEnded) {
      try { res.end(); } catch { /* socket closed */ }
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`StoryCut is running at http://127.0.0.1:${port}`);
  console.log(`Mode: ${process.env.OPENAI_API_KEY ? "AI enabled" : "local demo (no API key)"}`);
});
