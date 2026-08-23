import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectProject } from "./project-workspace.mjs";

const INDEX_SCHEMA_VERSION = 1;
export const DEFAULT_PROJECT_INDEX_ROOT = process.env.STORYCUT_PROJECT_INDEX_DIR
  || path.join(os.homedir(), "Library", "Caches", "StoryCut", "project-index");

export function projectSessionId(projectRoot) {
  return crypto.createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 24);
}

function indexFile(projectRoot, cacheRoot = DEFAULT_PROJECT_INDEX_ROOT) {
  return path.join(cacheRoot, `${projectSessionId(projectRoot)}.json`);
}

function inside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

async function statSignature(filePath, kind) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) return null;
  if (kind === "directory" && !stat.isDirectory()) return null;
  if (kind === "file" && !stat.isFile()) return null;
  return {
    path: filePath,
    kind,
    size: kind === "file" ? stat.size : 0,
    mtimeMs: Math.floor(stat.mtimeMs)
  };
}

function importantArtifact(artifact, activeVersion) {
  const relative = String(artifact?.relativePath || "");
  if (!relative) return false;
  if (!relative.includes("/")) return true;
  if (activeVersion && (relative === activeVersion || relative.startsWith(`${activeVersion}/`))) return true;
  return relative.startsWith("review/") || relative.includes("/review/");
}

async function buildValidationEntries(inspection) {
  const filePaths = new Set();
  const directoryPaths = new Set([inspection.editRoot]);
  const activeVersion = inspection.project.activeVersion;
  for (const artifact of inspection.project.artifacts || []) {
    if (!importantArtifact(artifact, activeVersion)) continue;
    const filePath = inspection.fileMap.get(artifact.id);
    if (filePath && inside(inspection.editRoot, filePath)) filePaths.add(filePath);
  }
  for (const version of inspection.project.versions || []) {
    const versionRoot = path.join(inspection.editRoot, version.id);
    if (inside(inspection.editRoot, versionRoot)) directoryPaths.add(versionRoot);
    for (const relativeDirectory of [version.clipPreviewDir, version.clipDraftDir]) {
      if (!relativeDirectory) continue;
      const directory = path.resolve(inspection.editRoot, relativeDirectory);
      if (inside(inspection.editRoot, directory)) directoryPaths.add(directory);
    }
  }
  const manifestPath = inspection.project.manifest?.relativePath
    ? path.join(inspection.editRoot, inspection.project.manifest.relativePath)
    : null;
  if (manifestPath && inside(inspection.editRoot, manifestPath)) filePaths.add(manifestPath);

  const signatures = await Promise.all([
    ...[...directoryPaths].map((filePath) => statSignature(filePath, "directory")),
    ...[...filePaths].map((filePath) => statSignature(filePath, "file"))
  ]);
  return signatures.filter(Boolean);
}

async function validationMatches(entries) {
  if (!Array.isArray(entries) || !entries.length) return false;
  for (let offset = 0; offset < entries.length; offset += 32) {
    const batch = entries.slice(offset, offset + 32);
    const current = await Promise.all(batch.map((entry) => statSignature(entry.path, entry.kind)));
    for (let index = 0; index < batch.length; index += 1) {
      const expected = batch[index];
      const actual = current[index];
      if (!actual || actual.size !== expected.size || actual.mtimeMs !== expected.mtimeMs) return false;
    }
  }
  return true;
}

function serializableFileMap(inspection) {
  return [...inspection.fileMap.entries()].filter(([, filePath]) => inside(inspection.editRoot, filePath));
}

function hydrate(payload, durationMs) {
  const editRoot = path.resolve(payload.editRoot);
  const entries = Array.isArray(payload.fileMap)
    ? payload.fileMap.filter((entry) => Array.isArray(entry) && entry.length === 2 && inside(editRoot, entry[1]))
    : [];
  return {
    projectRoot: path.resolve(payload.projectRoot),
    editRoot,
    project: payload.project,
    fileMap: new Map(entries),
    reviewTimelineCache: new Map(),
    index: {
      cacheHit: true,
      mode: "reused",
      indexedAt: payload.indexedAt,
      durationMs,
      validationCount: payload.validation.length,
      cacheLocation: "~/Library/Caches/StoryCut/project-index"
    }
  };
}

async function readCachedInspection(projectRoot, cacheRoot) {
  const raw = await fs.readFile(indexFile(projectRoot, cacheRoot), "utf8").catch(() => "");
  if (!raw) return null;
  let payload;
  try { payload = JSON.parse(raw); } catch { return null; }
  if (payload?.schemaVersion !== INDEX_SCHEMA_VERSION) return null;
  if (path.resolve(payload.projectRoot || "") !== path.resolve(projectRoot)) return null;
  if (!payload.project || !payload.editRoot || !Array.isArray(payload.validation)) return null;
  if (!inside(projectRoot, payload.editRoot) && path.resolve(projectRoot) !== path.resolve(payload.editRoot)) return null;
  return await validationMatches(payload.validation) ? payload : null;
}

export async function restoreProjectIndexed(projectId, options = {}) {
  const key = String(projectId || "").trim();
  if (!/^[a-f0-9]{24}$/.test(key)) return null;
  const cacheRoot = options.cacheRoot || DEFAULT_PROJECT_INDEX_ROOT;
  const raw = await fs.readFile(path.join(cacheRoot, `${key}.json`), "utf8").catch(() => "");
  if (!raw) return null;
  let payload;
  try { payload = JSON.parse(raw); } catch { return null; }
  if (payload?.schemaVersion !== INDEX_SCHEMA_VERSION || !payload.projectRoot) return null;
  if (projectSessionId(payload.projectRoot) !== key) return null;
  const cached = await readCachedInspection(payload.projectRoot, cacheRoot).catch(() => null);
  if (cached) return hydrate(cached, 0);
  return inspectProjectIndexed(payload.projectRoot, { cacheRoot });
}

async function writeCachedInspection(inspection, cacheRoot) {
  const validation = await buildValidationEntries(inspection);
  const payload = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    indexedAt: new Date().toISOString(),
    projectRoot: inspection.projectRoot,
    editRoot: inspection.editRoot,
    project: inspection.project,
    fileMap: serializableFileMap(inspection),
    validation
  };
  await fs.mkdir(cacheRoot, { recursive: true });
  const target = indexFile(inspection.projectRoot, cacheRoot);
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(payload)}\n`, "utf8");
  await fs.rename(temporary, target);
  return payload;
}

export async function inspectProjectIndexed(inputPath, options = {}) {
  const startedAt = Date.now();
  const requestedPath = String(inputPath || "").trim();
  if (!requestedPath) throw new Error("Choose a local project directory.");
  const projectRoot = path.resolve(requestedPath);
  const cacheRoot = options.cacheRoot || DEFAULT_PROJECT_INDEX_ROOT;
  if (!options.refresh) {
    const payload = await readCachedInspection(projectRoot, cacheRoot).catch(() => null);
    if (payload) return hydrate(payload, Date.now() - startedAt);
  }
  const inspection = await inspectProject(projectRoot);
  const payload = await writeCachedInspection(inspection, cacheRoot).catch(() => null);
  inspection.index = {
    cacheHit: false,
    mode: options.refresh ? "refreshed" : "rebuilt",
    indexedAt: payload?.indexedAt || new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    validationCount: payload?.validation?.length || 0,
    cacheLocation: "~/Library/Caches/StoryCut/project-index"
  };
  return inspection;
}

async function directorySummary(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const fileEntries = entries.filter((entry) => entry.isFile());
  const files = [];
  for (let offset = 0; offset < fileEntries.length; offset += 32) {
    const batch = await Promise.all(fileEntries.slice(offset, offset + 32).map(async (entry) => {
      const stat = await fs.stat(path.join(directory, entry.name)).catch(() => null);
      return stat ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
    }));
    files.push(...batch);
  }
  return {
    count: files.filter(Boolean).length,
    bytes: files.filter(Boolean).reduce((total, item) => total + item.size, 0),
    updatedAt: files.filter(Boolean).reduce((latest, item) => Math.max(latest, item.mtimeMs), 0)
  };
}

export async function projectIndexCacheStatus(cacheRoot = DEFAULT_PROJECT_INDEX_ROOT) {
  return directorySummary(cacheRoot);
}

export async function projectIndexCacheStatusFor(projectId, cacheRoot = DEFAULT_PROJECT_INDEX_ROOT) {
  const safeId = String(projectId || "");
  if (!/^[a-f0-9]{24}$/.test(safeId)) return null;
  const filePath = path.join(cacheRoot, `${safeId}.json`);
  const stat = await fs.stat(filePath).catch(() => null);
  return stat?.isFile()
    ? { count: 1, bytes: stat.size, updatedAt: stat.mtimeMs }
    : { count: 0, bytes: 0, updatedAt: 0 };
}

export async function clearProjectIndexCache(cacheRoot = DEFAULT_PROJECT_INDEX_ROOT) {
  const before = await projectIndexCacheStatus(cacheRoot);
  await fs.rm(cacheRoot, { recursive: true, force: true });
  return { removedCount: before.count, removedBytes: before.bytes };
}

export async function clearProjectIndexCacheFor(projectId, cacheRoot = DEFAULT_PROJECT_INDEX_ROOT) {
  const safeId = String(projectId || "");
  if (!/^[a-f0-9]{24}$/.test(safeId)) throw new Error("Invalid StoryCut project index id.");
  const filePath = path.join(cacheRoot, `${safeId}.json`);
  const stat = await fs.stat(filePath).catch(() => null);
  await fs.rm(filePath, { force: true });
  return {
    removedCount: stat?.isFile() ? 1 : 0,
    removedBytes: stat?.isFile() ? stat.size : 0
  };
}
