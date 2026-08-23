import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildReviewTimeline,
  inspectProject,
  parseSrt,
  readProjectDocument,
  saveReview,
  saveSubtitleCorrection
} from "../src/project-workspace.mjs";
import {
  applyEditProposal,
  buildEditWorkspace,
  proposeEdit,
  saveEditPreview,
  undoLastEdit
} from "../src/edit-workspace.mjs";

async function fixtureProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycut-project-"));
  const edit = path.join(root, "edit");
  await fs.mkdir(path.join(edit, "verify"), { recursive: true });
  await fs.writeFile(path.join(edit, "project.md"), "# Project\n\nCurrent stage: rough cut.\n");
  await fs.writeFile(path.join(edit, "edl_v2.json"), JSON.stringify({
    segments: [{ id: "opening", timeline_in: 0, timeline_out: 4 }],
    music_cues_v4: [{
      asset: "/local/licensed/fixture-theme.mp3",
      start: 5,
      duration: 3,
      gain: 0.12
    }]
  }));
  await fs.writeFile(path.join(edit, "master_v2.srt"), "1\n00:00:00,000 --> 00:00:01,000\nSafe demo\n\n2\n00:00:01,500 --> 00:00:03,500\nSecond cue\n");
  await fs.writeFile(path.join(edit, "graphics_plan.md"), "## 章节卡\n\n| 时间 | 文案 |\n|---|---|\n| 00:00:01.000 | `01｜开始` |\n\n## 花字\n\n| 00:00:02.000 | `重点` |\n");
  await fs.writeFile(path.join(edit, "music_recommendation.md"), [
    "| 00:00:00.500–00:00:03.000 | Demo BGM |",
    "",
    "- 冷开场 00:00:00–00:00:27 不加音乐，随后 00:00:30 再进入。"
  ].join("\n"));
  await fs.writeFile(path.join(edit, "sfx_recommendation.md"), "| 00:00:02.500 | Soft click |\n");
  await fs.writeFile(path.join(edit, "verify", "preview.mp4"), "synthetic-placeholder");
  return { root, edit };
}

test("inspectProject classifies a local edit directory without reading source media", async (t) => {
  const fixture = await fixtureProject();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = await inspectProject(fixture.root);
  assert.equal(result.project.artifactCount, 7);
  assert.equal(result.project.memory.kind, "memory");
  assert.equal(result.project.currentEdl.kind, "edl");
  assert.equal(result.project.transcript.kind, "transcript");
  assert.equal(result.project.preview.kind, "preview");
  const content = await readProjectDocument(result.fileMap.get(result.project.memory.id));
  assert.match(content, /rough cut/);
});

test("inspectProject selects a newly rendered packaged preview as the latest version", async (t) => {
  const fixture = await fixtureProject();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const packaged = path.join(fixture.edit, "hq_packaged_v4");
  await fs.mkdir(packaged, { recursive: true });
  const latest = path.join(packaged, "v4_hq_bgm.mp4");
  await fs.writeFile(latest, "newer-synthetic-placeholder");
  await fs.utimes(path.join(fixture.edit, "verify", "preview.mp4"), new Date("2026-01-01"), new Date("2026-01-01"));
  await fs.utimes(latest, new Date("2026-01-02"), new Date("2026-01-02"));
  const result = await inspectProject(fixture.root);
  assert.equal(result.project.preview.relativePath, "hq_packaged_v4/v4_hq_bgm.mp4");
});

test("review timeline combines current subtitles, EDL cuts, and creative markers", async (t) => {
  const fixture = await fixtureProject();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const inspection = await inspectProject(fixture.root);
  const timeline = await buildReviewTimeline(inspection);
  const cachedTimeline = await buildReviewTimeline(inspection);
  assert.strictEqual(cachedTimeline, timeline);
  assert.equal(timeline.subtitle.cues.length, 2);
  assert.deepEqual(new Set(timeline.markers.map((item) => item.type)), new Set(["cut", "chapter", "flower", "bgm", "sfx"]));
  assert.equal(timeline.markers.some((item) => item.type === "bgm" && item.time === 5 && item.label === "fixture-theme"), true);
  assert.equal(timeline.markers.some((item) => item.label.includes("冷开场")), false);
  assert.equal(parseSrt("1\n00:00:00,000 --> 00:00:01,000\nHello\n")[0].text, "Hello");
});

test("review timeline merges incremental flower text with earlier graphics plans", async (t) => {
  const fixture = await fixtureProject();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.writeFile(path.join(fixture.edit, "graphics_plan_v4.md"), [
    "# Incremental graphics v4",
    "",
    "## 花字",
    "",
    "| 时间 | 花字 |",
    "|---|---|",
    "| 00:00:05.000–00:00:07.000 | `New v4 flower` |"
  ].join("\n"));
  const inspection = await inspectProject(fixture.root);
  const timeline = await buildReviewTimeline(inspection);
  const flowers = timeline.markers.filter((item) => item.type === "flower");
  assert.equal(flowers.some((item) => item.time === 2 && item.label === "重点"), true);
  assert.equal(flowers.some((item) => item.time === 5 && item.label === "New v4 flower"), true);
});

test("subtitle corrections are version-safe and applied to the review timeline", async (t) => {
  const fixture = await fixtureProject();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  let inspection = await inspectProject(fixture.root);
  const cue = (await buildReviewTimeline(inspection)).subtitle.cues[0];
  const saved = await saveSubtitleCorrection(fixture.edit, {
    track: "master_v2.srt",
    cueId: cue.id,
    index: cue.index,
    start: cue.start,
    end: cue.end,
    originalText: cue.text,
    correctedText: "Corrected safe demo"
  });
  assert.equal(saved.count, 1);
  inspection = await inspectProject(fixture.root);
  const corrected = (await buildReviewTimeline(inspection)).subtitle.cues[0];
  assert.equal(corrected.text, "Corrected safe demo");
  assert.equal(corrected.corrected, true);
  assert.equal(await fs.readFile(path.join(fixture.edit, "master_v2.srt"), "utf8").then((text) => text.includes("Safe demo")), true);
});

test("saveReview writes a versioned structured round and a Codex prompt", async (t) => {
  const fixture = await fixtureProject();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = await saveReview(fixture.edit, {
    preview: "verify/preview.mp4",
    feedback: [{
      start: 12.4,
      end: 18.2,
      category: "pace",
      note: "Tighten repetition but keep the real reaction.",
      mustKeep: "The laugh at the end.",
      locked: true,
      priority: "high"
    }]
  });
  assert.equal(result.round, 1);
  assert.match(result.prompt, /edit\/review\/current\.json/);
  assert.match(result.prompt, /Tighten repetition/);
  const current = JSON.parse(await fs.readFile(path.join(fixture.edit, "review", "current.json"), "utf8"));
  assert.equal(current.feedback[0].status, "pending");
  assert.equal(current.feedback[0].locked, true);
});

test("edit workspace turns EDL ranges into selectable clips and proposes a reversible removal", async (t) => {
  const fixture = await fixtureProject();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const inspection = await inspectProject(fixture.root);
  const workspace = await buildEditWorkspace(inspection);
  assert.equal(workspace.clips.length, 1);
  assert.deepEqual(workspace.currentCut, {
    source: "edl_v2.json",
    preview: "verify/preview.mp4",
    clipCount: 1,
    sourceCount: 1,
    sourceKeys: ["source"],
    excludedClipCount: 0,
    duration: 4,
    derivedFrom: "current EDL ranges"
  });
  assert.equal(workspace.assets[0].usedInCurrentCut, true);
  assert.equal(workspace.assets[0].usedClipCount, 1);
  assert.equal(workspace.assets[0].status, "used");
  const proposal = proposeEdit(workspace, {
    command: "这个镜头不用剪辑入正片，移除即可。",
    selection: { type: "clip", id: workspace.clips[0].id, assetId: workspace.clips[0].sourceKey }
  });
  assert.equal(proposal.operation.type, "remove_clip");
  assert.equal(proposal.durationAfter < proposal.durationBefore, true);
  const inserted = proposeEdit(workspace, {
    command: "选取这条素材的 00:00:01–00:00:02",
    selection: { type: "asset", assetId: workspace.clips[0].sourceKey }
  });
  assert.equal(inserted.operation.type, "insert_range");
});

test("edit workspace trusts a matching timeline.csv for the rendered cut positions", async (t) => {
  const fixture = await fixtureProject();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await fs.writeFile(path.join(fixture.edit, "timeline.csv"), [
    "index,output_start,output_end,source,source_start,source_end,chapter,beat,reason",
    "0,0.000,4.250,source,0.000,4.000,OPENING,Rendered shot,Timeline padding is intentional."
  ].join("\n"));
  const inspection = await inspectProject(fixture.root);
  const workspace = await buildEditWorkspace(inspection);
  assert.equal(workspace.clips[0].timelineOut, 4.25);
  assert.equal(workspace.clips[0].duration, 4.25);
  assert.equal(workspace.duration, 4.25);
  assert.equal(workspace.currentCut.derivedFrom, "current EDL ranges + timeline.csv");
});

test("edit workspace honors an explicit active manifest over mtime", async (t) => {
  const fixture = await fixtureProject();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const active = path.join(fixture.edit, "rough_cut_v9_r2");
  await fs.mkdir(active, { recursive: true });
  await fs.writeFile(path.join(active, "edl.json"), JSON.stringify({ ranges: [{ source: "C0001", start: 2, end: 5, beat: "Manifest clip" }] }));
  await fs.writeFile(path.join(active, "master.srt"), "1\n00:00:00,000 --> 00:00:01,000\nActive\n");
  await fs.writeFile(path.join(active, "preview.mp4"), "active");
  await fs.writeFile(path.join(fixture.edit, "storycut_manifest.json"), JSON.stringify({
    schemaVersion: 1,
    active: { preview: "rough_cut_v9_r2/preview.mp4", edl: "rough_cut_v9_r2/edl.json", subtitle: "rough_cut_v9_r2/master.srt" }
  }));
  const inspection = await inspectProject(fixture.root);
  assert.equal(inspection.project.preview.relativePath, "rough_cut_v9_r2/preview.mp4");
  assert.equal(inspection.project.currentEdl.relativePath, "rough_cut_v9_r2/edl.json");
  const workspace = await buildEditWorkspace(inspection);
  assert.equal(workspace.clips[0].beat, "Manifest clip");
});

test("schema-v2 projects expose every review version and scope EDL plus proxies to the selected version", async (t) => {
  const fixture = await fixtureProject();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const createVersion = async (id, source, duration, beat) => {
    const root = path.join(fixture.edit, id);
    await fs.mkdir(path.join(root, "clips_preview"), { recursive: true });
    await fs.mkdir(path.join(root, "clips_draft"), { recursive: true });
    await fs.writeFile(path.join(root, "preview.mp4"), `${id}-preview`);
    await fs.writeFile(path.join(root, "preview_draft.mp4"), `${id}-draft`);
    await fs.writeFile(path.join(root, "edl.json"), JSON.stringify({
      schemaVersion: 2,
      versionId: id,
      sources: { [source]: `/local/${source}.MP4` },
      ranges: [{
        id: "shot-000", index: 0, source, sourceKey: source, sourcePath: `/local/${source}.MP4`,
        sourceIn: 0, sourceOut: duration, timelineIn: 0, timelineOut: duration, duration,
        chapter: "Test", beat
      }]
    }));
    await fs.writeFile(path.join(root, "clips_preview", `seg_000_${source}.mp4`), "proxy-preview");
    await fs.writeFile(path.join(root, "clips_draft", `seg_000_${source}.mp4`), "proxy-draft");
  };
  await createVersion("rough_cut_v1_r1", "C0001", 4, "Active clip");
  await createVersion("rough_cut_v1_r2", "C0002", 6, "Historical clip");
  await fs.writeFile(path.join(fixture.edit, "rough_cut_v1_r1", "graphics_plan.json"), JSON.stringify({
    preview: "rough_cut_v1_r1/preview.mp4",
    slots: [{ kind: "chapter", text: "Base chapter", start: 1, duration: 2 }]
  }));
  await fs.writeFile(path.join(fixture.edit, "rough_cut_v1_r2", "graphics_plan.json"), JSON.stringify({
    base_preview: "rough_cut_v1_r1/preview.mp4",
    preview: "rough_cut_v1_r2/preview.mp4",
    additions: [{ kind: "label", text: "Incremental label", start: 2, duration: 2 }]
  }));
  await fs.writeFile(path.join(fixture.edit, "storycut_manifest.json"), JSON.stringify({
    schemaVersion: 2,
    activeVersion: "rough_cut_v1_r1",
    active: {
      preview: "rough_cut_v1_r1/preview.mp4",
      draftPreview: "rough_cut_v1_r1/preview_draft.mp4",
      edl: "rough_cut_v1_r1/edl.json",
      clipPreviewDir: "rough_cut_v1_r1/clips_preview",
      clipDraftDir: "rough_cut_v1_r1/clips_draft"
    },
    versions: ["rough_cut_v1_r1", "rough_cut_v1_r2"].map((id) => ({
      id,
      label: id === "rough_cut_v1_r1" ? "V1 current" : "V1 previous",
      preview: `${id}/preview.mp4`,
      draftPreview: `${id}/preview_draft.mp4`,
      edl: `${id}/edl.json`,
      clipPreviewDir: `${id}/clips_preview`,
      clipDraftDir: `${id}/clips_draft`
    }))
  }));

  const inspection = await inspectProject(fixture.root);
  assert.equal(inspection.project.activeVersion, "rough_cut_v1_r1");
  assert.equal(inspection.project.preview.relativePath, "rough_cut_v1_r1/preview.mp4");
  assert.deepEqual(inspection.project.versions.map((item) => item.id), ["rough_cut_v1_r1", "rough_cut_v1_r2"]);
  assert.equal(inspection.project.versions[0].proxies.preview.length, 1);
  assert.equal(inspection.project.versions[0].proxies.draft.length, 1);

  const historical = await buildEditWorkspace(inspection, { versionId: "rough_cut_v1_r2" });
  assert.equal(historical.activeVersion, "rough_cut_v1_r2");
  assert.equal(historical.projectActiveVersion, "rough_cut_v1_r1");
  assert.equal(historical.clips[0].sourceKey, "C0002");
  assert.equal(historical.clips[0].proxyName, "seg_000_C0002.mp4");
  assert.equal(historical.clips[0].proxyPreviewFileId.length, 16);
  assert.equal(historical.clips[0].proxyDraftFileId.length, 16);
  assert.equal(historical.preview.standard.relativePath, "rough_cut_v1_r2/preview.mp4");
  assert.equal(historical.preview.draft.relativePath, "rough_cut_v1_r2/preview_draft.mp4");
  assert.equal(historical.timeline.versionId, "rough_cut_v1_r2");
  assert.equal(historical.timeline.markers.some((item) => item.type === "cut" && item.time === 0), true);
  assert.equal(historical.timeline.markers.some((item) => item.type === "chapter" && item.label === "Base chapter"), true);
  assert.equal(historical.timeline.markers.some((item) => item.type === "flower" && item.label === "Incremental label"), true);
  const baseChapter = historical.timeline.markers.find((item) => item.type === "chapter" && item.label === "Base chapter");
  const incrementalLabel = historical.timeline.markers.find((item) => item.type === "flower" && item.label === "Incremental label");
  assert.deepEqual([baseChapter.time, baseChapter.end], [1, 3]);
  assert.deepEqual([incrementalLabel.time, incrementalLabel.end], [2, 4]);
});

test("edit preview keeps a local diff artifact when media rendering is unavailable", async (t) => {
  const fixture = await fixtureProject();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const inspection = await inspectProject(fixture.root);
  const workspace = await buildEditWorkspace(inspection);
  const proposal = proposeEdit(workspace, {
    command: "这个镜头不用剪辑入正片",
    selection: { type: "clip", id: workspace.clips[0].id, assetId: workspace.clips[0].sourceKey }
  });
  const preview = await saveEditPreview(inspection, proposal);
  assert.equal(typeof preview.relativePath, "string");
  assert.equal(preview.renderedVideo, false);
  assert.match(preview.renderReason, /ffmpeg|video|Invalid|格式|exited|截取/i);
});

test("applying an edit writes a visible draft EDL and undo removes the draft state", async (t) => {
  const fixture = await fixtureProject();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const inspection = await inspectProject(fixture.root);
  const workspace = await buildEditWorkspace(inspection);
  const proposal = proposeEdit(workspace, {
    command: "这个镜头不用剪辑入正片",
    selection: { type: "clip", id: workspace.clips[0].id, assetId: workspace.clips[0].sourceKey }
  });
  const applied = await applyEditProposal(inspection, proposal);
  const draftPath = path.join(fixture.edit, "edl_storycut_draft.json");
  assert.equal(applied.workspace.clips[0].status, "excluded");
  assert.equal(applied.workspace.currentCut.clipCount, 0);
  assert.equal(applied.workspace.currentCut.sourceCount, 0);
  assert.equal(applied.workspace.assets[0].usedDuration, 0);
  assert.equal(applied.workspace.assets[0].usedClipCount, 0);
  assert.equal(applied.workspace.assets[0].status, "excluded");
  assert.equal(await fs.stat(draftPath).then(() => true), true);
  const undone = await undoLastEdit(inspection);
  assert.equal(undone.workspace.clips[0].status, "included");
  assert.equal(await fs.stat(draftPath).then(() => true).catch(() => false), false);
});
