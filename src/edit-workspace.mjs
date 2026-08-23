import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { buildReviewTimeline } from "./project-workspace.mjs";

const OPERATION_LOG = "edit_operations.jsonl";
const DRAFT_EDL = "edl_storycut_draft.json";
const WORK_ROOT = [".work", "storycut-edit"];

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampTime(value) {
  return Number(Math.max(0, number(value)).toFixed(3));
}

function cleanLabel(value, fallback = "未命名镜头") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 160);
}

function readSource(data, sourceKey) {
  const sources = data?.sources;
  if (sources && typeof sources === "object" && !Array.isArray(sources)) {
    return sources[sourceKey] || sourceKey;
  }
  return sourceKey;
}

function asRange(item, index, timelineCursor, sources) {
  const sourceKey = String(item.source || item.asset || item.source_id || item.clip || "source");
  const sourcePath = item.sourcePath || item.source_path || readSource(sources, sourceKey);
  const sourceIn = clampTime(item.start ?? item.source_in ?? item.sourceIn ?? item.in ?? 0);
  const declaredOut = item.end ?? item.source_out ?? item.sourceOut ?? item.out;
  const duration = Math.max(0, number(item.duration, 0));
  const sourceOut = clampTime(declaredOut === undefined ? sourceIn + duration : declaredOut);
  const clipDuration = Math.max(0.001, sourceOut - sourceIn || duration || 0.001);
  const timelineIn = clampTime(item.timeline_in ?? item.timelineIn ?? timelineCursor);
  const timelineOut = clampTime(item.timeline_out ?? item.timelineOut ?? timelineIn + clipDuration);
  return {
    id: String(item.id || item.name || `clip-${String(index + 1).padStart(3, "0")}`).slice(0, 120),
    index: Number.isInteger(Number(item.index)) && Number(item.index) >= 0 ? Number(item.index) : index,
    sourceKey: sourceKey.slice(0, 120),
    sourcePath: String(sourcePath || sourceKey).slice(0, 2000),
    sourceName: path.basename(String(sourcePath || sourceKey)),
    sourceIn,
    sourceOut: Math.max(sourceIn + 0.001, sourceOut),
    timelineIn,
    timelineOut: Math.max(timelineIn + 0.001, timelineOut),
    duration: Number(Math.max(0.001, timelineOut - timelineIn).toFixed(3)),
    chapter: cleanLabel(item.chapter || item.section, "未分章"),
    beat: cleanLabel(item.beat || item.reason || item.title, "镜头"),
    reason: cleanLabel(item.reason, "保留当前叙事节奏"),
    status: item.exclude || item.enabled === false || item.status === "excluded" ? "excluded" : "included",
    metadata: {
      aRole: item.a_role || item.aRole || "",
      bFunction: item.b_function || item.bFunction || "",
      flowerOverlay: item.flower_overlay || "",
      chapterOverlay: item.chapter_overlay || ""
    }
  };
}

function extractRanges(data) {
  if (!data || typeof data !== "object") return [];
  const ranges = Array.isArray(data.ranges)
    ? data.ranges
    : Array.isArray(data.segments)
      ? data.segments
      : Array.isArray(data.clips)
        ? data.clips
        : [];
  let cursor = 0;
  return ranges.map((item, index) => {
    const clip = asRange(item || {}, index, cursor, data);
    cursor = clip.timelineOut;
    return clip;
  });
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

async function readJson(filePath) {
  if (!filePath) return null;
  const raw = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function readBaseEdl(inspection, version = null) {
  const artifact = version?.edl || inspection.project.currentEdl;
  if (!artifact) return { data: { version: 1, ranges: [] }, artifact: null, filePath: null };
  const filePath = inspection.fileMap.get(artifact.id);
  return { data: await readJson(filePath) || { version: 1, ranges: [] }, artifact, filePath };
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (const char of String(line || "")) {
    if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(value);
      value = "";
    } else {
      value += char;
    }
  }
  values.push(value);
  return values.map((item) => item.trim().replace(/^"|"$/g, ""));
}

async function readTimelineCsv(filePath) {
  if (!filePath) return [];
  const csvPath = path.join(path.dirname(filePath), "timeline.csv");
  const raw = await fs.readFile(csvPath, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  const rows = raw.trim().split(/\r?\n/).slice(1).map(parseCsvLine);
  return rows.flatMap((row) => {
    const [index, outputStart, outputEnd, source, sourceStart, sourceEnd] = row;
    const timelineIn = Number(outputStart);
    const timelineOut = Number(outputEnd);
    if (!Number.isFinite(timelineIn) || !Number.isFinite(timelineOut) || timelineOut <= timelineIn || !source) return [];
    return [{
      index: Number(index),
      source: String(source),
      timelineIn: clampTime(timelineIn),
      timelineOut: clampTime(timelineOut),
      sourceIn: clampTime(sourceStart),
      sourceOut: clampTime(sourceEnd)
    }];
  });
}

function applyTimelineRows(clips, rows) {
  if (!rows.length) return { clips, source: null };
  const next = clips.map((clip, index) => {
    const row = rows[index];
    if (!row || row.source !== clip.sourceKey) return clip;
    const timelineIn = row.timelineIn;
    const timelineOut = Math.max(timelineIn + 0.001, row.timelineOut);
    const sourceIn = Number.isFinite(row.sourceIn) ? row.sourceIn : clip.sourceIn;
    const sourceOut = Number.isFinite(row.sourceOut) && row.sourceOut > sourceIn ? row.sourceOut : clip.sourceOut;
    return {
      ...clip,
      sourceIn,
      sourceOut,
      timelineIn,
      timelineOut,
      duration: Number((timelineOut - timelineIn).toFixed(3))
    };
  });
  const matched = next.filter((clip, index) => rows[index]?.source === clip.sourceKey).length;
  return matched === clips.length ? { clips: next, source: "timeline.csv" } : { clips, source: null };
}

function logPath(editRoot) {
  return path.join(editRoot, OPERATION_LOG);
}

function workRoot(editRoot) {
  return path.join(editRoot, ...WORK_ROOT);
}

async function readOperationRecords(editRoot) {
  const raw = await fs.readFile(logPath(editRoot), "utf8").catch(() => "");
  return raw.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" ? [value] : [];
    } catch {
      return [];
    }
  });
}

function activeOperations(records) {
  const undone = new Set(records.filter((item) => item.kind === "undo").map((item) => item.targetId));
  return records.filter((item) => item.kind === "apply" && !undone.has(item.id));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

export function applyOperations(clips, operations) {
  const next = clone(clips);
  for (const operation of operations) {
    const op = operation.operation || operation;
    if (op.type === "exclude_asset") {
      for (const clip of next) {
        if (clip.sourceKey === op.assetId) clip.status = "excluded";
      }
    } else if (op.type === "remove_clip") {
      const clip = next.find((item) => item.id === op.clipId);
      if (clip) clip.status = "excluded";
    } else if (op.type === "trim_clip") {
      const clip = next.find((item) => item.id === op.clipId);
      if (!clip) continue;
      const start = clampTime(op.sourceIn ?? clip.sourceIn);
      const end = clampTime(op.sourceOut ?? clip.sourceOut);
      if (end <= start) clip.status = "excluded";
      else {
        clip.sourceIn = start;
        clip.sourceOut = end;
        clip.duration = Number(Math.max(0.001, end - start).toFixed(3));
      }
    } else if (op.type === "insert_range") {
      const inserted = {
        id: op.clipId || `insert-${crypto.randomUUID().slice(0, 8)}`,
        index: next.length,
        sourceKey: op.assetId,
        sourcePath: op.sourcePath || op.assetId,
        sourceName: path.basename(op.sourcePath || op.assetId),
        sourceIn: clampTime(op.sourceIn),
        sourceOut: clampTime(op.sourceOut),
        timelineIn: 0,
        timelineOut: 0,
        duration: Number(Math.max(0.001, number(op.sourceOut) - number(op.sourceIn)).toFixed(3)),
        chapter: cleanLabel(op.chapter, "新增镜头"),
        beat: cleanLabel(op.label, "用户选取片段"),
        reason: cleanLabel(op.reason, "用户从素材中选取"),
        status: "included",
        metadata: {}
      };
      next.splice(Math.max(0, number(op.insertAt, next.length)), 0, inserted);
    }
  }
  let cursor = 0;
  for (const [index, clip] of next.entries()) {
    clip.index = index;
    if (clip.status === "excluded") {
      clip.timelineIn = cursor;
      clip.timelineOut = cursor;
      continue;
    }
    clip.timelineIn = Number(cursor.toFixed(3));
    clip.timelineOut = Number((cursor + clip.duration).toFixed(3));
    cursor = clip.timelineOut;
  }
  return next;
}

function expectedProxyName(clip) {
  const safeSourceKey = String(clip.sourceKey || "source").replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `seg_${String(clip.index).padStart(3, "0")}_${safeSourceKey}.mp4`;
}

function attachClipProxies(clips, version) {
  const previewByName = new Map((version?.proxies?.preview || []).map((item) => [item.name, item]));
  const draftByName = new Map((version?.proxies?.draft || []).map((item) => [item.name, item]));
  return clips.map((clip) => {
    const proxyName = expectedProxyName(clip);
    const preview = previewByName.get(proxyName) || null;
    const draft = draftByName.get(proxyName) || null;
    return {
      ...clip,
      proxyName,
      proxyPreviewFileId: preview?.id || null,
      proxyDraftFileId: draft?.id || null
    };
  });
}

function buildAssets(clips, inspection) {
  const byId = new Map();
  for (const clip of clips) {
    const existing = byId.get(clip.sourceKey) || {
      id: clip.sourceKey,
      name: clip.sourceName,
      pathLabel: path.basename(clip.sourcePath || clip.sourceKey),
      type: "video",
      clipCount: 0,
      usedClipCount: 0,
      excludedClipCount: 0,
      usedDuration: 0,
      timelineRanges: [],
      sourceRanges: []
    };
    existing.clipCount += 1;
    if (clip.status === "excluded") {
      existing.excludedClipCount += 1;
    } else {
      existing.usedClipCount += 1;
      existing.usedDuration = Number((existing.usedDuration + clip.duration).toFixed(3));
      existing.timelineRanges.push({ start: clip.timelineIn, end: clip.timelineOut, clipId: clip.id });
      existing.sourceRanges.push({ start: clip.sourceIn, end: clip.sourceOut, clipId: clip.id });
      if (!existing.proxyPreviewFileId && clip.proxyPreviewFileId) existing.proxyPreviewFileId = clip.proxyPreviewFileId;
      if (!existing.proxyDraftFileId && clip.proxyDraftFileId) existing.proxyDraftFileId = clip.proxyDraftFileId;
    }
    byId.set(clip.sourceKey, existing);
  }
  // If an EDL exists, keep the bin focused on its source assets. Generated
  // cover frames and dozens of derivative clips belong in 项目文件, not in
  // the conversational selection surface. Projects without an EDL still get
  // a useful fallback bin from playable local artifacts.
  if (!byId.size) {
    for (const artifact of inspection.project.artifacts.filter((item) => item.kind === "preview").slice(0, 40)) {
      byId.set(artifact.name, {
        id: artifact.name,
        name: artifact.name,
        pathLabel: artifact.relativePath,
        type: "video",
        clipCount: 0,
        usedClipCount: 0,
        excludedClipCount: 0,
        usedDuration: 0,
        timelineRanges: [],
        sourceRanges: [],
        artifactId: artifact.id
      });
    }
  }
  return [...byId.values()].map((asset) => ({
    ...asset,
    usedInCurrentCut: asset.usedClipCount > 0,
    status: asset.usedClipCount === 0
      ? (asset.excludedClipCount > 0 ? "excluded" : "unknown")
      : asset.excludedClipCount > 0 ? "partial" : "used"
  })).sort((a, b) => b.usedClipCount - a.usedClipCount || a.name.localeCompare(b.name));
}

function publicClip(clip) {
  const { sourcePath, metadata, ...safe } = clip;
  return { ...safe, sourcePathLabel: path.basename(sourcePath || clip.sourceKey), metadata };
}

function resolveWorkspaceVersion(inspection, versionId) {
  const versions = inspection.project.versions || [];
  if (versionId) {
    const selected = versions.find((item) => item.id === versionId);
    if (!selected) throw new Error(`Unknown StoryCut review version: ${versionId}`);
    return selected;
  }
  return versions.find((item) => item.id === inspection.project.activeVersion)
    || versions.find((item) => item.isActive)
    || null;
}

function publicWorkspaceVersion(version, projectActiveVersion) {
  return {
    id: version.id,
    label: version.label,
    isActive: version.id === projectActiveVersion,
    preview: version.preview ? { id: version.preview.id, relativePath: version.preview.relativePath } : null,
    draftPreview: version.draftPreview ? { id: version.draftPreview.id, relativePath: version.draftPreview.relativePath } : null,
    edl: version.edl ? { id: version.edl.id, relativePath: version.edl.relativePath } : null,
    clipPreviewDir: version.clipPreviewDir,
    clipDraftDir: version.clipDraftDir,
    clipCount: version.clipCount,
    duration: version.duration
  };
}

export async function buildEditWorkspace(inspection, options = {}) {
  const version = resolveWorkspaceVersion(inspection, options.versionId);
  const { data, artifact, filePath } = await readBaseEdl(inspection, version);
  const extractedClips = extractRanges(data);
  const timelineRows = await readTimelineCsv(filePath);
  const timelineApplied = applyTimelineRows(extractedClips, timelineRows);
  const baseClips = timelineApplied.clips;
  const records = await readOperationRecords(inspection.editRoot);
  const operations = activeOperations(records);
  const scopedOperations = !version || version.id === inspection.project.activeVersion ? operations : [];
  const clips = attachClipProxies(applyOperations(baseClips, scopedOperations), version);
  const included = clips.filter((clip) => clip.status !== "excluded");
  const duration = Number(included.reduce((total, clip) => total + clip.duration, 0).toFixed(3));
  const usedSourceKeys = [...new Set(included.map((clip) => clip.sourceKey))];
  const timeline = await buildReviewTimeline(inspection, version ? { versionId: version.id } : {});
  return {
    schemaVersion: 2,
    base: artifact ? { name: artifact.name, relativePath: artifact.relativePath } : null,
    activeVersion: version?.id || inspection.project.activeVersion || null,
    projectActiveVersion: inspection.project.activeVersion || null,
    versions: (inspection.project.versions || []).map((item) => publicWorkspaceVersion(item, inspection.project.activeVersion)),
    preview: version
      ? {
          standard: version.preview ? { id: version.preview.id, relativePath: version.preview.relativePath } : null,
          draft: version.draftPreview ? { id: version.draftPreview.id, relativePath: version.draftPreview.relativePath } : null
        }
      : {
          standard: inspection.project.preview ? { id: inspection.project.preview.id, relativePath: inspection.project.preview.relativePath } : null,
          draft: null
        },
    timeline,
    assets: buildAssets(clips, inspection),
    clips: clips.map(publicClip),
    duration,
    currentCut: {
      source: artifact?.relativePath || null,
      preview: version?.preview?.relativePath || inspection.project.preview?.relativePath || null,
      clipCount: included.length,
      sourceCount: usedSourceKeys.length,
      sourceKeys: usedSourceKeys,
      excludedClipCount: clips.length - included.length,
      duration,
      derivedFrom: artifact
        ? timelineApplied.source ? `current EDL ranges + ${timelineApplied.source}` : "current EDL ranges"
        : "no EDL"
    },
    operations: records.filter((item) => item.kind === "apply").slice(-40).map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      summary: item.summary,
      status: activeOperations(records).some((active) => active.id === item.id) ? "applied" : "undone"
    })),
    draft: scopedOperations.length ? { relativePath: DRAFT_EDL, operationCount: scopedOperations.length } : null,
    sourceDuration: duration,
    selectedClipId: null
  };
}

function parseSeconds(value) {
  const raw = String(value || "").replace(",", ".").trim();
  if (!raw) return NaN;
  const parts = raw.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return NaN;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts.at(-3) * 3600 + parts.at(-2) * 60 + parts.at(-1);
}

function firstTimeRange(command) {
  const matches = [...String(command || "").matchAll(/(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?|\b\d{1,4}(?:[.,]\d{1,3})?\s*(?:秒|s)\b/g)];
  const values = matches.map((match) => parseSeconds(match[0].replace(/秒|s/gi, ""))).filter(Number.isFinite);
  return values.length >= 2 ? { start: clampTime(values[0]), end: clampTime(values[1]) } : null;
}

function selectedClip(workspace, selection) {
  const clipId = String(selection?.clipId || selection?.id || "");
  return workspace.clips.find((clip) => clip.id === clipId && clip.status !== "excluded") || null;
}

function proposalSummary(type, clip, assetId, range) {
  if (type === "exclude_asset") return `从正片移除素材 ${assetId} 的全部 ${clip ? "相关镜头" : "镜头"}`;
  if (type === "remove_clip") return `移除镜头 ${clip?.beat || clip?.id || "当前选中镜头"}`;
  if (type === "trim_clip") return `收紧 ${clip?.beat || clip?.id || "当前镜头"}，保留 ${formatTime(range.start)}–${formatTime(range.end)}`;
  return `插入 ${assetId || "当前素材"} 的 ${formatTime(range.start)}–${formatTime(range.end)} 片段`;
}

function formatTime(seconds) {
  const value = Math.max(0, number(seconds));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = Math.floor(value % 60);
  const ms = Math.round((value % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

export function proposeEdit(workspace, input) {
  const command = String(input?.command || "").trim().slice(0, 2000);
  if (!command) throw new Error("请先描述想怎么剪。");
  const selection = input?.selection || {};
  const clip = selectedClip(workspace, selection);
  const range = firstTimeRange(command) || (Number.isFinite(Number(selection.rangeStart)) && Number.isFinite(Number(selection.rangeEnd))
    ? { start: clampTime(selection.rangeStart), end: clampTime(selection.rangeEnd) }
    : null);
  const selectedAsset = String(selection.assetId || clip?.sourceKey || "").trim();
  const words = command.toLowerCase();
  let type;
  if (/(整条.*(不用|不要|移除|排除)|这个素材.*(不用|不要|移除|排除)|素材.*不用|不用.*(剪|入正片)|不要.*(剪|入正片)|移除素材|排除素材|这条视频.*(不用|不要|移除|排除))/.test(command)
    && selectedAsset && (selection.type === "asset" || !clip || !/这个镜头|该镜头|当前镜头/.test(command))) type = "exclude_asset";
  else if (/(不用剪|不要剪|删掉|删除|移除|去掉|不需要)/.test(command) && clip) type = "remove_clip";
  else if (/(选取|截取|插入|加入|用这段|挑这段)/.test(command) && range) type = "insert_range";
  else if (clip && (range || /(前面|后面|开头|结尾|收紧|缩短|保留)/.test(command))) type = "trim_clip";
  else if (selectedAsset && range) type = "insert_range";
  else throw new Error("没有识别出可执行操作。请先选中素材/镜头，并说明删除、收紧或选取的范围。");

  const effectiveRange = range || { start: clip?.sourceIn || 0, end: clip?.sourceOut || 0 };
  const operation = type === "exclude_asset"
    ? { type, assetId: selectedAsset }
    : type === "remove_clip"
      ? { type, clipId: clip.id }
      : type === "trim_clip"
        ? { type, clipId: clip.id, sourceIn: Math.max(clip.sourceIn, effectiveRange.start), sourceOut: Math.min(clip.sourceOut, effectiveRange.end) }
        : { type, assetId: selectedAsset, sourceIn: effectiveRange.start, sourceOut: effectiveRange.end, insertAt: clip?.index ?? workspace.clips.length, clipId: `insert-${crypto.randomUUID().slice(0, 8)}`, label: command };
  const before = workspace.clips.filter((item) => operation.type === "exclude_asset" ? item.sourceKey === operation.assetId : item.id === operation.clipId).map(publicClip);
  const afterClips = applyOperations(workspace.clips, [{ operation }]);
  const after = afterClips.filter((item) => before.some((entry) => entry.id === item.id) || item.id === operation.clipId).map(publicClip);
  const summary = proposalSummary(type, clip, selectedAsset, effectiveRange);
  return {
    id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
    command,
    operation,
    summary,
    affected: before.map((item) => ({ id: item.id, label: item.beat, time: `${formatTime(item.timelineIn)}–${formatTime(item.timelineOut)}` })),
    before,
    after,
    durationBefore: workspace.duration,
    durationAfter: Number(afterClips.filter((item) => item.status !== "excluded").reduce((sum, item) => sum + item.duration, 0).toFixed(3)),
    reversible: true,
    preview: { kind: "timeline-diff", label: "局部时间线预览", generated: false }
  };
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

async function writeDraft(inspection, workspace) {
  const root = workRoot(inspection.editRoot);
  await fs.mkdir(root, { recursive: true });
  const draftPath = path.join(root, "draft-edl.json");
  const visibleDraftPath = path.join(inspection.editRoot, DRAFT_EDL);
  const ranges = workspace.clips.map((clip) => ({
    id: clip.id,
    source: clip.sourceKey,
    start: clip.sourceIn,
    end: clip.sourceOut,
    timeline_in: clip.timelineIn,
    timeline_out: clip.timelineOut,
    chapter: clip.chapter,
    beat: clip.beat,
    reason: clip.reason,
    status: clip.status
  }));
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    base: workspace.base,
    clips: workspace.clips,
    ranges,
    duration: workspace.duration
  };
  await fs.writeFile(draftPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await fs.writeFile(visibleDraftPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return path.relative(inspection.editRoot, visibleDraftPath);
}

export async function applyEditProposal(inspection, proposal) {
  if (!proposal?.operation || !proposal.id) throw new Error("剪辑提议无效。");
  const current = await buildEditWorkspace(inspection);
  const nextClips = applyOperations(current.clips, [{ operation: proposal.operation }]);
  const record = {
    schemaVersion: 1,
    kind: "apply",
    id: proposal.id,
    createdAt: new Date().toISOString(),
    command: proposal.command,
    summary: proposal.summary,
    operation: proposal.operation,
    before: proposal.before,
    after: proposal.after
  };
  await appendJsonLine(logPath(inspection.editRoot), record);
  const nextIncluded = nextClips.filter((item) => item.status !== "excluded");
  const nextDuration = Number(nextIncluded.reduce((sum, item) => sum + item.duration, 0).toFixed(3));
  const nextSourceKeys = [...new Set(nextIncluded.map((item) => item.sourceKey))];
  const nextWorkspace = {
    ...current,
    assets: buildAssets(nextClips, inspection),
    clips: nextClips.map(publicClip),
    duration: nextDuration,
    currentCut: {
      ...current.currentCut,
      clipCount: nextIncluded.length,
      sourceCount: nextSourceKeys.length,
      sourceKeys: nextSourceKeys,
      excludedClipCount: nextClips.length - nextIncluded.length,
      duration: nextDuration
    }
  };
  nextWorkspace.draft = { relativePath: await writeDraft(inspection, nextWorkspace), operationCount: current.operations.length + 1 };
  return { record, workspace: nextWorkspace };
}

function previewSegments(proposal, duration) {
  const first = proposal?.before?.[0];
  if (!first || !Number.isFinite(Number(first.timelineIn))) return [];
  const centerStart = Math.max(0, number(first.timelineIn));
  const centerEnd = Math.min(Math.max(centerStart, duration), number(first.timelineOut, centerStart));
  const leftStart = Math.max(0, centerStart - 1.5);
  const rightDuration = Math.max(0, Math.min(2.5, duration - centerEnd));
  const segments = [];
  if (centerStart - leftStart > 0.12) segments.push({ start: leftStart, duration: centerStart - leftStart });
  if (rightDuration > 0.12) segments.push({ start: centerEnd, duration: rightDuration });
  return segments;
}

async function renderPreviewVideo(inspection, proposal, outputPath) {
  const previewArtifact = inspection.project.preview;
  const inputPath = previewArtifact && inspection.fileMap.get(previewArtifact.id);
  if (!inputPath) return { rendered: false, reason: "没有可用的当前审片视频。" };
  const segments = previewSegments(proposal, Math.max(0, number(proposal.durationBefore)));
  if (!segments.length) return { rendered: false, reason: "当前操作没有可截取的局部画面。" };

  const tempRoot = path.join(workRoot(inspection.editRoot), "tmp", proposal.id);
  await fs.mkdir(tempRoot, { recursive: true });
  const extracted = [];
  try {
    for (const [index, segment] of segments.entries()) {
      const segmentPath = path.join(tempRoot, `segment-${index}.mp4`);
      await runProcess(process.env.FFMPEG_BIN || "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-ss", String(segment.start), "-i", inputPath, "-t", String(segment.duration),
        "-map", "0:v:0", "-map", "0:a:0?", "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32",
        "-c:a", "aac", "-b:a", "96k", "-ar", "48000", "-ac", "2", "-shortest",
        "-movflags", "+faststart", segmentPath
      ]);
      extracted.push(segmentPath);
    }
    if (extracted.length === 1) {
      await fs.rename(extracted[0], outputPath);
    } else {
      const concatList = path.join(tempRoot, "concat.txt");
      const lines = extracted.map((filePath) => `file '${filePath.replaceAll("'", "'\\''")}'`).join("\n");
      await fs.writeFile(concatList, `${lines}\n`, "utf8");
      await runProcess(process.env.FFMPEG_BIN || "ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0",
        "-i", concatList, "-c", "copy", "-movflags", "+faststart", outputPath
      ]);
    }
    return { rendered: true, duration: segments.reduce((sum, segment) => sum + segment.duration, 0) };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function saveEditPreview(inspection, proposal) {
  if (!proposal?.id || !proposal?.operation) throw new Error("剪辑提议无效。");
  const previewRoot = path.join(workRoot(inspection.editRoot), "previews");
  await fs.mkdir(previewRoot, { recursive: true });
  const relativePath = path.join(...WORK_ROOT, "previews", `${proposal.id}.json`);
  const filePath = path.join(inspection.editRoot, relativePath);
  const videoRelativePath = path.join(...WORK_ROOT, "previews", `${proposal.id}.mp4`);
  const videoPath = path.join(inspection.editRoot, videoRelativePath);
  const videoFileId = `edit-preview-${proposal.id}`;
  let render = { rendered: false, reason: "尚未生成视频预览。" };
  try {
    render = await renderPreviewVideo(inspection, proposal, videoPath);
    if (render.rendered) inspection.fileMap.set(videoFileId, videoPath);
  } catch (error) {
    render = { rendered: false, reason: error instanceof Error ? error.message.slice(0, 400) : "视频预览生成失败。" };
    await fs.unlink(videoPath).catch(() => {});
  }
  const payload = {
    schemaVersion: 1,
    kind: "storycut-timeline-diff",
    generatedAt: new Date().toISOString(),
    summary: proposal.summary,
    command: proposal.command,
    operation: proposal.operation,
    before: proposal.before,
    after: proposal.after,
    durationBefore: proposal.durationBefore,
    durationAfter: proposal.durationAfter,
    renderedVideo: render.rendered,
    renderedVideoFileId: render.rendered ? videoFileId : null,
    renderedVideoRelativePath: render.rendered ? videoRelativePath : null,
    renderReason: render.reason,
    note: "这是确认前的本地时间线差异预览，不会覆盖源素材或已确认版本。"
  };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return {
    relativePath,
    generatedAt: payload.generatedAt,
    renderedVideo: payload.renderedVideo,
    renderedVideoFileId: payload.renderedVideoFileId,
    renderedVideoRelativePath: payload.renderedVideoRelativePath,
    renderReason: payload.renderReason
  };
}

export async function undoLastEdit(inspection) {
  const records = await readOperationRecords(inspection.editRoot);
  const active = activeOperations(records);
  const target = active.at(-1);
  if (!target) throw new Error("没有可撤销的剪辑操作。");
  const undo = { schemaVersion: 1, kind: "undo", id: crypto.randomUUID().replaceAll("-", "").slice(0, 16), targetId: target.id, createdAt: new Date().toISOString(), summary: `撤销：${target.summary}` };
  await appendJsonLine(logPath(inspection.editRoot), undo);
  const workspace = await buildEditWorkspace(inspection);
  if (activeOperations(await readOperationRecords(inspection.editRoot)).length) {
    workspace.draft = { relativePath: await writeDraft(inspection, workspace), operationCount: workspace.operations.filter((item) => item.status === "applied").length };
  } else {
    await fs.unlink(path.join(inspection.editRoot, DRAFT_EDL)).catch(() => {});
    await fs.unlink(path.join(workRoot(inspection.editRoot), "draft-edl.json")).catch(() => {});
    workspace.draft = null;
  }
  return { undo, workspace };
}

export const editConstants = Object.freeze({ OPERATION_LOG, DRAFT_EDL, WORK_ROOT });
