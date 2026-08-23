import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DOCUMENT_EXTENSIONS = new Set([".md", ".txt", ".json", ".jsonl", ".tsv", ".csv", ".srt", ".ass"]);
const MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mp3", ".m4a", ".wav"]);
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const SKIP_DIRECTORIES = new Set([".git", ".work", "node_modules", "uploads", "private", "clips_preview", "clips_draft", "__pycache__"]);
const MAX_DOCUMENT_BYTES = 1_000_000;
const MAX_SCAN_FILES = 5000;
const MANIFEST_NAMES = ["storycut_manifest.json", "active_manifest.json"];
const VERSION_PATTERN = /^rough_cut_v\d+_r\d+$/i;
const VERSION_FILE_KEYS = ["preview", "draftPreview", "edl", "subtitle", "graphicsPlan", "soundMap", "review"];

function artifactKind(relativePath) {
  const name = path.basename(relativePath).toLowerCase();
  const ext = path.extname(name);
  if (MEDIA_EXTENSIONS.has(ext)) return "preview";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (/project\.md$/.test(name)) return "memory";
  if (/inventory/.test(name)) return "inventory";
  if (/edl/.test(name)) return "edl";
  if (/story|gate1|discussion/.test(name)) return "story";
  if (/select|broll|visual.index/.test(name)) return "selects";
  if (/\.srt$|\.ass$|transcript|takes.packed/.test(name)) return "transcript";
  if (/graphics|packaging|music|sfx|sound[_ -]?map|recommendation/.test(name)) return "plan";
  if (/review|prompt|feedback|operation/.test(name)) return "review";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  return "other";
}

function titleFor(relativePath) {
  return path.basename(relativePath).replace(/[_-]+/g, " ").replace(/\.[^.]+$/, "");
}

function allowedArtifact(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  return DOCUMENT_EXTENSIONS.has(ext) || MEDIA_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext);
}

async function walk(directory, base, files, depth = 0) {
  if (depth > 4 || files.length >= MAX_SCAN_FILES) return;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const directories = [];
  const candidates = [];
  for (const entry of entries) {
    if (files.length >= MAX_SCAN_FILES) return;
    if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      directories.push(absolute);
      continue;
    }
    const relativePath = path.relative(base, absolute);
    if (!allowedArtifact(relativePath)) continue;
    candidates.push({ absolute, relativePath });
  }
  for (let offset = 0; offset < candidates.length && files.length < MAX_SCAN_FILES; offset += 24) {
    const batch = candidates.slice(offset, offset + 24);
    const stats = await Promise.all(batch.map(async (item) => ({ ...item, stat: await fs.stat(item.absolute).catch(() => null) })));
    for (const item of stats) {
      if (files.length >= MAX_SCAN_FILES) break;
      if (item.stat?.isFile()) files.push(item);
    }
  }
  for (const child of directories) {
    if (files.length >= MAX_SCAN_FILES) break;
    await walk(child, base, files, depth + 1);
  }
}

function versionKey(relativePath) {
  const match = String(relativePath).match(/rough_cut_v(\d+)(?:_r(\d+))?/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0)];
}

function compareVersionedPath(a, b) {
  const av = versionKey(a.relativePath);
  const bv = versionKey(b.relativePath);
  if (!av && !bv) return 0;
  if (!av) return -1;
  if (!bv) return 1;
  return av[0] - bv[0] || av[1] - bv[1];
}

async function readManifest(editRoot) {
  for (const name of MANIFEST_NAMES) {
    const manifestPath = path.join(editRoot, name);
    const raw = await fs.readFile(manifestPath, "utf8").catch(() => "");
    if (!raw) continue;
    try {
      const data = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        return { data, relativePath: name };
      }
    } catch {
      // Keep scanning if a stale manifest is malformed.
    }
  }
  return null;
}

function manifestPathValue(manifest, key) {
  const value = manifest?.active?.[key] ?? manifest?.[key];
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function safeRelativePath(editRoot, value) {
  if (!value || path.isAbsolute(value)) return null;
  const resolved = path.resolve(editRoot, value);
  return resolved.startsWith(`${editRoot}${path.sep}`) ? resolved : null;
}

function manifestVersionEntries(manifest) {
  const entries = Array.isArray(manifest?.versions) ? manifest.versions : [];
  return entries.filter((item) => item && typeof item === "object" && VERSION_PATTERN.test(String(item.id || "")));
}

function versionRootsFromFiles(files) {
  const roots = new Set();
  for (const file of files) {
    const [root] = String(file.relativePath).split(/[\\/]/);
    if (VERSION_PATTERN.test(root)) roots.add(root);
  }
  return [...roots].sort(compareVersionedPath);
}

function versionPathValue(entry, key, activeVersion, manifest) {
  const own = entry?.[key];
  if (typeof own === "string" && own.trim()) return own.trim();
  if (entry?.id === activeVersion) return manifestPathValue(manifest, key);
  return null;
}

function inferredVersionPath(versionId, key) {
  const names = {
    preview: "preview.mp4",
    draftPreview: "preview_draft.mp4",
    edl: "edl.json",
    subtitle: "master.srt",
    graphicsPlan: "graphics_plan.json",
    soundMap: "sound_map.json",
    review: path.join("review", "current.json"),
    clipPreviewDir: "clips_preview",
    clipDraftDir: "clips_draft"
  };
  return names[key] ? path.join(versionId, names[key]) : null;
}

async function listRegisteredMedia(editRoot, relativeDirectory, fileMap) {
  const directory = safeRelativePath(editRoot, relativeDirectory);
  if (!directory) return [];
  const stat = await fs.stat(directory).catch(() => null);
  if (!stat?.isDirectory()) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const media = [];
  for (const entry of entries) {
    if (!entry.isFile() || !MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const absolute = path.join(directory, entry.name);
    const id = crypto.createHash("sha256").update(absolute).digest("hex").slice(0, 16);
    fileMap.set(id, absolute);
    media.push({ id, name: entry.name, relativePath: path.relative(editRoot, absolute).split(path.sep).join("/") });
  }
  return media.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function preferredVersionRoot(editRoot, files) {
  const roots = new Map();
  for (const file of files) {
    const match = file.relativePath.match(/^(rough_cut_v\d+(?:_r\d+)?)(?:[\\/]|$)/i);
    if (match) roots.set(match[1], match[1]);
  }
  const candidates = [...roots.values()]
    .map((name) => ({ name, key: versionKey(name) }))
    .filter((item) => item.key)
    .sort((a, b) => b.key[0] - a.key[0] || b.key[1] - a.key[1]);
  return candidates[0]?.name || null;
}

function publicArtifact(file) {
  const ext = path.extname(file.relativePath).toLowerCase();
  return {
    id: crypto.createHash("sha256").update(file.absolute).digest("hex").slice(0, 16),
    name: path.basename(file.relativePath),
    title: titleFor(file.relativePath),
    relativePath: file.relativePath,
    kind: artifactKind(file.relativePath),
    extension: ext.slice(1),
    sizeBytes: file.stat.size,
    modifiedAt: file.stat.mtime.toISOString(),
    readable: DOCUMENT_EXTENSIONS.has(ext) && file.stat.size <= MAX_DOCUMENT_BYTES,
    playable: MEDIA_EXTENSIONS.has(ext),
    image: IMAGE_EXTENSIONS.has(ext)
  };
}

export async function inspectProject(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) throw new Error("Choose a local project directory.");
  const projectRoot = path.resolve(inputPath.trim());
  const stat = await fs.stat(projectRoot).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("That project directory does not exist.");

  const nestedEdit = path.join(projectRoot, "edit");
  const nestedStat = await fs.stat(nestedEdit).catch(() => null);
  const editRoot = nestedStat?.isDirectory() ? nestedEdit : projectRoot;
  const files = [];
  await walk(editRoot, editRoot, files);

  // A manifest is optional, but when present it is the source of truth for the
  // active version. This keeps a 1,000+ file edit folder from accidentally
  // opening an older preview just because a generated asset has a newer mtime.
  const manifest = await readManifest(editRoot);
  const declaredVersions = manifestVersionEntries(manifest?.data);
  const declaredActiveVersion = typeof manifest?.data?.activeVersion === "string" && VERSION_PATTERN.test(manifest.data.activeVersion)
    ? manifest.data.activeVersion
    : null;
  const activeVersion = declaredActiveVersion || await preferredVersionRoot(editRoot, files);
  const knownVersionIds = new Set([
    ...declaredVersions.map((item) => item.id),
    ...versionRootsFromFiles(files),
    ...(activeVersion ? [activeVersion] : [])
  ]);
  const versionEntries = [...knownVersionIds]
    .map((id) => declaredVersions.find((item) => item.id === id) || { id, label: id })
    .sort((a, b) => compareVersionedPath({ relativePath: a.id }, { relativePath: b.id }));
  const explicitPaths = [
    manifestPathValue(manifest?.data, "preview"),
    manifestPathValue(manifest?.data, "edl"),
    manifestPathValue(manifest?.data, "subtitle"),
    manifestPathValue(manifest?.data, "graphicsPlan"),
    manifestPathValue(manifest?.data, "soundMap"),
    manifestPathValue(manifest?.data, "review")
  ].map((value) => safeRelativePath(editRoot, value)).filter(Boolean);
  for (const entry of versionEntries) {
    for (const key of VERSION_FILE_KEYS) {
      const relativePath = versionPathValue(entry, key, activeVersion, manifest?.data) || inferredVersionPath(entry.id, key);
      const absolute = safeRelativePath(editRoot, relativePath);
      if (absolute) explicitPaths.push(absolute);
    }
  }
  if (activeVersion) {
    for (const file of files) {
      if (file.relativePath.startsWith(`${activeVersion}${path.sep}`)) explicitPaths.push(file.absolute);
    }
  }
  const existing = new Set(files.map((file) => file.absolute));
  for (const absolute of explicitPaths) {
    if (existing.has(absolute)) continue;
    const fileStat = await fs.stat(absolute).catch(() => null);
    if (!fileStat?.isFile()) continue;
    const relativePath = path.relative(editRoot, absolute);
    if (!allowedArtifact(relativePath)) continue;
    files.push({ absolute, relativePath, stat: fileStat });
    existing.add(absolute);
  }

  const artifactPairs = files.map((file) => ({ file, artifact: publicArtifact(file) }));
  const artifacts = artifactPairs.map((item) => item.artifact).sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const fileMap = new Map(artifactPairs.map((item) => [item.artifact.id, item.file.absolute]));
  const artifactByRelative = new Map(artifacts.map((item) => [item.relativePath, item]));
  const manifestPreview = manifestPathValue(manifest?.data, "preview");
  const manifestEdl = manifestPathValue(manifest?.data, "edl");
  const manifestSubtitle = manifestPathValue(manifest?.data, "subtitle");
  const versionFiles = activeVersion
    ? artifacts.filter((item) => item.relativePath === activeVersion || item.relativePath.startsWith(`${activeVersion}/`))
    : [];
  const versionPreview = versionFiles.filter((item) => item.kind === "preview")
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))[0];
  const preview = artifactByRelative.get(manifestPreview)
    || versionPreview
    || artifacts.find((item) => item.kind === "preview")
    || null;
  const memory = artifacts.find((item) => item.kind === "memory") || null;
  const currentEdl = artifactByRelative.get(manifestEdl)
    || versionFiles.find((item) => item.kind === "edl")
    || artifacts.find((item) => item.kind === "edl")
    || null;
  const transcript = artifacts.find((item) => item.kind === "transcript") || null;
  const subtitleCandidates = artifacts.filter((item) => item.extension === "srt" || item.extension === "ass");
  const subtitle = subtitleCandidates.sort((a, b) => {
    const score = (item) => (/master|subtitle|clean|final/i.test(item.name) ? 10 : 0) + (item.extension === "srt" ? 2 : 0);
    return score(b) - score(a) || b.modifiedAt.localeCompare(a.modifiedAt);
  })[0] || null;
  const activeSubtitle = artifactByRelative.get(manifestSubtitle)
    || versionFiles.find((item) => (item.extension === "srt" || item.extension === "ass") && /master|subtitle|clean|final/i.test(item.name))
    || subtitle;
  const versions = [];
  for (const entry of versionEntries) {
    const paths = Object.fromEntries(VERSION_FILE_KEYS.map((key) => [
      key,
      versionPathValue(entry, key, activeVersion, manifest?.data) || inferredVersionPath(entry.id, key)
    ]));
    const clipPreviewDir = versionPathValue(entry, "clipPreviewDir", activeVersion, manifest?.data)
      || inferredVersionPath(entry.id, "clipPreviewDir");
    const clipDraftDir = versionPathValue(entry, "clipDraftDir", activeVersion, manifest?.data)
      || inferredVersionPath(entry.id, "clipDraftDir");
    const proxies = {
      preview: await listRegisteredMedia(editRoot, clipPreviewDir, fileMap),
      draft: await listRegisteredMedia(editRoot, clipDraftDir, fileMap)
    };
    versions.push({
      id: entry.id,
      label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : entry.id,
      isActive: entry.id === activeVersion,
      ...Object.fromEntries(VERSION_FILE_KEYS.map((key) => [key, artifactByRelative.get(paths[key]) || null])),
      clipPreviewDir,
      clipDraftDir,
      proxies,
      clipCount: Number(entry.clipCount) || proxies.preview.length || proxies.draft.length || 0,
      duration: Number(entry.duration) || 0
    });
  }

  return {
    projectRoot,
    editRoot,
    project: {
      name: path.basename(projectRoot),
      artifactCount: artifacts.length,
      updatedAt: artifacts[0]?.modifiedAt || stat.mtime.toISOString(),
      preview,
      memory,
      currentEdl,
      transcript,
      subtitle: activeSubtitle,
      activeVersion,
      versions,
      manifest: manifest ? { relativePath: manifest.relativePath, ...manifest.data } : null,
      artifacts
    },
    fileMap,
    reviewTimelineCache: new Map()
  };
}

export async function readProjectDocument(filePath) {
  const stat = await fs.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(ext)) throw new Error("This file is not a readable project document.");
  if (stat.size > MAX_DOCUMENT_BYTES) throw new Error("Document is too large to preview.");
  return fs.readFile(filePath, "utf8");
}

function parseTimestamp(value) {
  const parts = String(value || "").trim().replace(",", ".").split(":").map(Number);
  if ((parts.length !== 2 && parts.length !== 3) || parts.some((item) => !Number.isFinite(item))) return NaN;
  return parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts[0] * 60 + parts[1];
}

export function parseSrt(content) {
  return String(content || "").replace(/\r/g, "").trim().split(/\n{2,}/).flatMap((block, index) => {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) return [];
    const match = lines[timingIndex].match(/^\s*([0-9:,.\s]+)\s*-->\s*([0-9:,.\s]+)/);
    if (!match) return [];
    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    const text = lines.slice(timingIndex + 1).join("\n").replace(/<[^>]+>/g, "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) return [];
    return [{
      id: `cue-${String(index + 1).padStart(5, "0")}`,
      index: index + 1,
      start: Number(start.toFixed(3)),
      end: Number(Math.max(start, end).toFixed(3)),
      text
    }];
  });
}

export function parseAss(content) {
  const cues = [];
  for (const line of String(content || "").replace(/\r/g, "").split("\n")) {
    if (!line.startsWith("Dialogue:")) continue;
    const fields = line.slice("Dialogue:".length).split(",");
    if (fields.length < 10) continue;
    const start = parseTimestamp(fields[1]);
    const end = parseTimestamp(fields[2]);
    const text = fields.slice(9).join(",").replace(/\{[^}]*\}/g, "").replace(/\\N/g, "\n").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || !text) continue;
    cues.push({
      id: `cue-${String(cues.length + 1).padStart(5, "0")}`,
      index: cues.length + 1,
      start: Number(start.toFixed(3)),
      end: Number(Math.max(start, end).toFixed(3)),
      text
    });
  }
  return cues;
}

function cleanMarkerLabel(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[`*_#]/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || fallback).slice(0, 100);
}

function markerTypeForPlan(name, line) {
  const value = `${name} ${line}`.toLowerCase();
  if (/music|bgm|音乐|曲目/.test(value)) return "bgm";
  if (/sfx|sound|音效|foley|环境声/.test(value)) return "sfx";
  if (/chapter|章节卡|章节/.test(value)) return "chapter";
  if (/flower|graphics|花字|关键词|label|overlay|addition/.test(value)) return "flower";
  return null;
}

function markerLabelFromLine(line, matchedTime, fallback) {
  const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
  const timeIndex = cells.findIndex((cell) => cell.includes(matchedTime));
  const candidate = cells.slice(Math.max(0, timeIndex + 1))
    .find((cell) => !cell.includes(matchedTime) && !/^[-:]+$/.test(cell));
  if (candidate) return cleanMarkerLabel(candidate, fallback);
  return cleanMarkerLabel(line.replace(matchedTime, ""), fallback);
}

function isStructuredMarkerLine(line, matchedTime) {
  const trimmed = String(line || "").trim();
  if (!trimmed || !matchedTime) return false;
  if (trimmed.startsWith("|")) {
    const cells = trimmed.split("|").map((cell) => cell.trim()).filter(Boolean);
    return cells.slice(0, 2).some((cell) => cell.includes(matchedTime));
  }
  const withoutBullet = trimmed.replace(/^[-+*]\s+/, "").replace(/^[`*_]+/, "");
  return withoutBullet.startsWith(matchedTime);
}

function collectEdlMarkers(value, markers, source, context = "") {
  if (Array.isArray(value)) {
    for (const item of value) collectEdlMarkers(item, markers, source, context);
    return;
  }
  if (!value || typeof value !== "object") return;
  const label = cleanMarkerLabel(value.label || value.title || value.text || value.id, "剪辑点");
  const declaredType = /countdown/i.test(String(value.kind || ""))
    ? "chapter"
    : markerTypeForPlan(context, `${value.kind || ""} ${value.type || ""}`);
  if (declaredType && Number.isFinite(Number(value.start))) {
    const start = Number(value.start);
    const explicitEnd = Number(value.end);
    const duration = Math.max(0, Number(value.duration) || 0);
    const end = Number.isFinite(explicitEnd) ? Math.max(start, explicitEnd) : start + duration;
    const markerLabel = value.asset
      ? path.basename(String(value.asset)).replace(/\.[^.]+$/, "")
      : cleanMarkerLabel(value.text || value.label || value.title, declaredType === "bgm" ? "BGM" : declaredType === "sfx" ? "音效" : "花字");
    markers.push({
      type: declaredType,
      time: start,
      end,
      label: cleanMarkerLabel(markerLabel, declaredType === "bgm" ? "BGM" : declaredType === "sfx" ? "音效" : "花字"),
      source
    });
  }
  const timelineIn = value.timeline_in ?? value.timelineIn;
  const timelineOut = value.timeline_out ?? value.timelineOut;
  if (Number.isFinite(Number(timelineIn))) {
    markers.push({ type: "cut", time: Number(timelineIn), end: Number(timelineOut) || Number(timelineIn), label, source });
  }
  if (Number.isFinite(Number(value.timeline_time))) {
    const rawType = String(value.type || "").toLowerCase();
    const type = /chapter/.test(rawType)
      ? "chapter"
      : /flower|graphic|text/.test(rawType)
        ? "flower"
        : /music|bgm/.test(rawType)
          ? "bgm"
          : /sfx|sound|foley/.test(rawType)
            ? "sfx"
            : "cut";
    markers.push({ type, time: Number(value.timeline_time), end: Number(value.timeline_time), label, source });
  }
  for (const [key, child] of Object.entries(value)) {
    if (child && typeof child === "object") collectEdlMarkers(child, markers, source, key);
  }
}

function collectChapterCardMarkers(edl, markers, source) {
  const cards = edl?.chapter_cards;
  const ranges = Array.isArray(edl?.ranges) ? edl.ranges : Array.isArray(edl?.segments) ? edl.segments : [];
  if (!cards || !ranges.length) return;
  let cursor = 0;
  const timelineRanges = ranges.map((range) => {
    const start = Number(range.start ?? range.source_in ?? range.sourceIn ?? 0);
    const end = Number(range.end ?? range.source_out ?? range.sourceOut ?? start);
    const duration = Math.max(0, end - start);
    const item = { source: String(range.source || range.asset || range.sourceKey || ""), start, end, timelineIn: cursor, timelineOut: cursor + duration };
    cursor += duration;
    return item;
  });
  let previousTimeline = -1;
  for (const [id, card] of Object.entries(cards)) {
    const cardSource = String(card?.source || "");
    const sourceStart = Number(card?.source_start);
    if (!cardSource || !Number.isFinite(sourceStart)) continue;
    const matchingRanges = timelineRanges.filter((item) => item.source === cardSource && sourceStart >= item.start && sourceStart <= item.end);
    const range = matchingRanges.find((item) => item.timelineIn >= previousTimeline)
      || matchingRanges.at(-1)
      || timelineRanges.find((item) => item.source === cardSource);
    if (!range) continue;
    const time = range.timelineIn + Math.max(0, sourceStart - range.start);
    const title = [card.title, card.countdown ? `距离离开还有 ${card.countdown}` : ""].filter(Boolean).join(" · ");
    markers.push({ type: "chapter", time: Number(time.toFixed(3)), end: Number((time + 3.25).toFixed(3)), label: cleanMarkerLabel(title, id), source });
    previousTimeline = time;
  }
}

async function readCorrections(editRoot) {
  const correctionPath = path.join(editRoot, "review", "subtitle-corrections.json");
  const raw = await fs.readFile(correctionPath, "utf8").catch(() => "");
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    return Array.isArray(data.corrections) ? data.corrections : [];
  } catch {
    return [];
  }
}

function normalizedRelative(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

async function versionPlanArtifacts(inspection, version) {
  if (!version) return inspection.project.artifacts;
  const chain = [];
  const seenVersions = new Set();
  const visitGraphicsPlan = async (currentVersion) => {
    if (!currentVersion || seenVersions.has(currentVersion.id)) return;
    seenVersions.add(currentVersion.id);
    const plan = currentVersion.graphicsPlan;
    if (!plan) return;
    const planPath = inspection.fileMap.get(plan.id);
    const data = plan.extension === "json" && planPath
      ? await fs.readFile(planPath, "utf8").then((raw) => JSON.parse(raw)).catch(() => null)
      : null;
    const basePreview = normalizedRelative(data?.base_preview ?? data?.basePreview);
    if (basePreview) {
      const baseVersion = inspection.project.versions?.find((candidate) =>
        normalizedRelative(candidate.preview?.relativePath) === basePreview
        || basePreview.startsWith(`${candidate.id}/`)
      );
      await visitGraphicsPlan(baseVersion);
    }
    chain.push(plan);
  };
  await visitGraphicsPlan(version);
  if (version.soundMap) chain.push(version.soundMap);
  return chain;
}

async function buildReviewTimelineUncached(inspection, options = {}) {
  const version = options.versionId
    ? inspection.project.versions?.find((item) => item.id === options.versionId)
    : null;
  if (options.versionId && !version) throw new Error(`Unknown StoryCut review version: ${options.versionId}`);
  const artifacts = await versionPlanArtifacts(inspection, version);
  const subtitle = version ? version.subtitle : inspection.project.subtitle;
  let cues = [];
  if (subtitle) {
    const subtitlePath = inspection.fileMap.get(subtitle.id);
    const content = await fs.readFile(subtitlePath, "utf8");
    cues = subtitle.extension === "ass" ? parseAss(content) : parseSrt(content);
    const corrections = await readCorrections(inspection.editRoot);
    const correctionMap = new Map(corrections
      .filter((item) => item.track === subtitle.relativePath)
      .map((item) => [item.cueId, item]));
    cues = cues.map((cue) => {
      const correction = correctionMap.get(cue.id);
      return correction ? { ...cue, text: correction.correctedText, originalText: correction.originalText, corrected: true } : cue;
    });
  }

  const markers = [];
  const selectedEdl = version ? version.edl : inspection.project.currentEdl;
  const edlArtifacts = selectedEdl?.extension === "json"
    ? [selectedEdl]
    : [];
  for (const artifact of edlArtifacts) {
    try {
      const data = JSON.parse(await fs.readFile(inspection.fileMap.get(artifact.id), "utf8"));
      collectEdlMarkers(data, markers, artifact.relativePath);
      collectChapterCardMarkers(data, markers, artifact.relativePath);
    } catch {
      // A malformed or non-JSON EDL is still available in the file browser.
    }
  }

  const planArtifacts = artifacts
    .filter((item) => item.kind === "plan" && item.readable)
    .slice(0, 16);
  const timePattern = /\b(?:\d{1,2}:)?\d{2}:\d{2}(?:[.,]\d{1,3})?\b/g;
  for (const artifact of planArtifacts) {
    const content = await fs.readFile(inspection.fileMap.get(artifact.id), "utf8").catch(() => "");
    if (artifact.extension === "json") {
      try {
        collectEdlMarkers(JSON.parse(content), markers, artifact.relativePath);
      } catch {
        // Keep the malformed plan visible in 项目文件 without blocking the review workspace.
      }
    }
    let sectionType = markerTypeForPlan(artifact.name, "");
    for (const line of content.split(/\r?\n/)) {
      if (/^\s*#{1,6}\s+/.test(line)) {
        sectionType = markerTypeForPlan("", line) || sectionType;
      }
      const type = markerTypeForPlan("", line) || sectionType || markerTypeForPlan(artifact.name, line);
      if (!type) continue;
      const matches = [...line.matchAll(timePattern)];
      if (!matches.length || matches.length > 2) continue;
      if (!isStructuredMarkerLine(line, matches[0][0])) continue;
      const start = parseTimestamp(matches[0][0]);
      if (!Number.isFinite(start)) continue;
      const end = matches[1] ? parseTimestamp(matches[1][0]) : start;
      const markerEnd = Number.isFinite(end) ? Math.max(start, end) : start;
      const planLabel = markerLabelFromLine(line, matches[0][0], artifact.title);
      const mergeByTime = type === "bgm" || type === "sfx" || type === "flower";
      const countdownPlan = type === "chapter" && /小时|倒计时/.test(planLabel);
      const alreadyMapped = markers.find((item) =>
        item.type === type
        && Math.abs(item.time - start) < (type === "sfx" ? 0.15 : 0.05)
        && (mergeByTime || (countdownPlan && /小时|倒计时|距离离开/.test(item.label)))
      );
      if (alreadyMapped) {
        if (/sound[_ -]?map/i.test(artifact.name) && (type === "bgm" || type === "sfx")) alreadyMapped.label = planLabel;
        continue;
      }
      markers.push({
        type,
        time: Number(start.toFixed(3)),
        end: Number(markerEnd.toFixed(3)),
        label: planLabel,
        source: artifact.relativePath
      });
    }
  }

  const seen = new Set();
  const deduped = markers
    .filter((item) => Number.isFinite(item.time) && item.time >= 0)
    .sort((a, b) => a.time - b.time)
    .filter((item) => {
      const key = `${item.type}:${Math.round(item.time * 10)}:${item.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 500);
  const duration = Math.max(0, ...cues.map((item) => item.end), ...deduped.map((item) => item.end || item.time));
  return {
    versionId: version?.id || inspection.project.activeVersion || null,
    subtitle: subtitle ? { id: subtitle.id, name: subtitle.name, relativePath: subtitle.relativePath, cues } : null,
    markers: deduped,
    duration
  };
}

export async function buildReviewTimeline(inspection, options = {}) {
  const cacheKey = options.versionId || "__active__";
  const cache = inspection.reviewTimelineCache;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  const pending = buildReviewTimelineUncached(inspection, options);
  cache?.set(cacheKey, pending);
  try {
    const timeline = await pending;
    cache?.set(cacheKey, timeline);
    return timeline;
  } catch (error) {
    cache?.delete(cacheKey);
    throw error;
  }
}

export async function saveSubtitleCorrection(editRoot, payload) {
  const track = String(payload.track || "").trim().slice(0, 500);
  const cueId = String(payload.cueId || "").trim().slice(0, 80);
  const correctedText = String(payload.correctedText || "").trim().slice(0, 1200);
  const originalText = String(payload.originalText || "").trim().slice(0, 1200);
  if (!track || !cueId || !correctedText) throw new Error("Subtitle correction is incomplete.");
  const correction = {
    track,
    cueId,
    index: Math.max(1, Number(payload.index) || 1),
    start: Math.max(0, Number(payload.start) || 0),
    end: Math.max(0, Number(payload.end) || 0),
    originalText,
    correctedText,
    status: "pending",
    updatedAt: new Date().toISOString()
  };
  const reviewRoot = path.join(editRoot, "review");
  const correctionPath = path.join(reviewRoot, "subtitle-corrections.json");
  await fs.mkdir(reviewRoot, { recursive: true });
  const corrections = await readCorrections(editRoot);
  const existingIndex = corrections.findIndex((item) => item.track === track && item.cueId === cueId);
  if (existingIndex === -1) corrections.push(correction);
  else corrections[existingIndex] = correction;
  const data = { schemaVersion: 1, updatedAt: correction.updatedAt, corrections };
  const temporary = `${correctionPath}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fs.rename(temporary, correctionPath);
  return { correction, count: corrections.length, relativePath: "review/subtitle-corrections.json" };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  const millis = Math.round((value % 1) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${String(millis).padStart(3, "0")}`;
}

function safeFeedback(input, index) {
  const start = Math.max(0, Number(input.start) || 0);
  const end = Math.max(start, Number(input.end) || start);
  return {
    id: `feedback-${String(index + 1).padStart(3, "0")}`,
    start: Number(start.toFixed(3)),
    end: Number(end.toFixed(3)),
    category: String(input.category || "general").slice(0, 40),
    note: String(input.note || "").trim().slice(0, 4000),
    mustKeep: String(input.mustKeep || "").trim().slice(0, 2000),
    locked: Boolean(input.locked),
    priority: ["low", "normal", "high"].includes(input.priority) ? input.priority : "normal",
    status: "pending"
  };
}

function markdownForReview(review) {
  const lines = [
    `# StoryCut review round ${review.round}`,
    "",
    `Created: ${review.createdAt}`,
    `Preview: ${review.preview || "Not selected"}`,
    "",
    "## Feedback",
    ""
  ];
  for (const item of review.feedback) {
    lines.push(
      `### ${item.id} · ${formatTime(item.start)}–${formatTime(item.end)}`,
      "",
      `- Category: ${item.category}`,
      `- Priority: ${item.priority}`,
      `- Locked: ${item.locked ? "yes" : "no"}`,
      `- Intent: ${item.note}`,
      `- Must keep: ${item.mustKeep || "None specified"}`,
      ""
    );
  }
  return lines.join("\n");
}

function promptForReview(review) {
  const feedbackLines = review.feedback.map((item) => [
    `- ${formatTime(item.start)}–${formatTime(item.end)} [${item.priority.toUpperCase()} / ${item.category}]`,
    `  Intent: ${item.note}`,
    `  Must keep: ${item.mustKeep || "No additional must-keep note."}`,
    `  Lock: ${item.locked ? "Treat this decision as locked after applying." : "Not locked."}`
  ].join("\n")).join("\n");

  return `请继续当前本地视频项目的剪辑。\n\n先完整读取 edit/project.md、当前 EDL、当前主字幕、edit/review/current.json，以及存在时的 edit/review/subtitle-corrections.json。使用 xiaolu-vlog-editor 工作流，并遵守已经锁定的故事、隐私和事实边界。\n\n本轮审片对象：${review.preview || "当前最新审片版"}\n\n用户反馈：\n${feedbackLines}\n\n执行要求：\n1. 把反馈翻译成精确时间范围和受影响资产，不要机械照抄操作。\n2. 把 pending 字幕校正应用到新版本字幕，但保留原始字幕文件。\n3. 保留无关的已锁定章节，禁止覆盖源素材或已确认版本。\n4. 同步更新 EDL、字幕、图形/声音方案和 project.md 中受影响的部分。\n5. 先生成能验证修改的最低成本局部或低码率预览。\n6. 自检切点、语义完整、反应尾巴、字幕同步、音频爆点和黑帧。\n7. 完成后将对应反馈和字幕校正标记为 resolved，并汇报修改前后差异。\n`;
}

export async function saveReview(editRoot, payload) {
  const reviewRoot = path.join(editRoot, "review");
  const roundsRoot = path.join(reviewRoot, "rounds");
  const promptsRoot = path.join(reviewRoot, "prompts");
  await fs.mkdir(roundsRoot, { recursive: true });
  await fs.mkdir(promptsRoot, { recursive: true });

  const entries = await fs.readdir(roundsRoot).catch(() => []);
  const round = entries.reduce((max, name) => {
    const match = name.match(/^review-(\d+)\.json$/);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  const slug = `review-${String(round).padStart(3, "0")}`;
  const feedback = Array.isArray(payload.feedback)
    ? payload.feedback.map(safeFeedback).filter((item) => item.note)
    : [];
  if (!feedback.length) throw new Error("Add at least one feedback note before saving.");

  const review = {
    schemaVersion: 1,
    round,
    createdAt: new Date().toISOString(),
    preview: String(payload.preview || "").slice(0, 500),
    feedback
  };
  const markdown = markdownForReview(review);
  const prompt = promptForReview(review);

  await Promise.all([
    fs.writeFile(path.join(roundsRoot, `${slug}.json`), JSON.stringify(review, null, 2) + "\n", "utf8"),
    fs.writeFile(path.join(roundsRoot, `${slug}.md`), markdown + "\n", "utf8"),
    fs.writeFile(path.join(promptsRoot, `${slug}-prompt.md`), prompt, "utf8"),
    fs.writeFile(path.join(reviewRoot, "current.json"), JSON.stringify(review, null, 2) + "\n", "utf8"),
    fs.writeFile(path.join(reviewRoot, "current.md"), markdown + "\n", "utf8")
  ]);

  return {
    round,
    files: [
      `review/rounds/${slug}.json`,
      `review/rounds/${slug}.md`,
      `review/prompts/${slug}-prompt.md`,
      "review/current.json",
      "review/current.md"
    ],
    prompt
  };
}

export const constants = Object.freeze({
  DOCUMENT_EXTENSIONS,
  MEDIA_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MAX_DOCUMENT_BYTES
});
