import test from "node:test";
import assert from "node:assert/strict";
import { compareEditWorkspaces, EDIT_DIFF_STATUSES } from "../src/edit-compare.mjs";

function clip(id, sourceKey, sourceIn, sourceOut, timelineIn, overrides = {}) {
  return {
    id,
    sourceKey,
    sourceIn,
    sourceOut,
    timelineIn,
    timelineOut: timelineIn + (sourceOut - sourceIn),
    duration: sourceOut - sourceIn,
    status: "included",
    ...overrides
  };
}

function workspace(version, clips, markers = []) {
  return { activeVersion: version, clips, timeline: { versionId: version, markers } };
}

test("compares clip additions, removals, trims, extensions, moves, and unchanged ranges", () => {
  const before = workspace("v4", [
    clip("same", "A", 0, 5, 0),
    clip("trim", "B", 0, 10, 5),
    clip("extend", "C", 5, 10, 15),
    clip("move", "D", 0, 4, 20),
    clip("remove", "E", 0, 2, 24)
  ]);
  const after = workspace("v5", [
    clip("same", "A", 0, 5, 0),
    clip("trim", "B", 2, 8, 5),
    clip("extend", "C", 3, 12, 11),
    clip("move", "D", 0, 4, 30),
    clip("add", "F", 0, 3, 34)
  ]);

  const result = compareEditWorkspaces(before, after);
  assert.equal(result.fromVersion, "v4");
  assert.equal(result.toVersion, "v5");
  assert.deepEqual(new Set(result.clips.map((item) => item.status)), new Set(EDIT_DIFF_STATUSES));
  assert.deepEqual(result.summary.clips, {
    before: 5,
    after: 5,
    added: 1,
    removed: 1,
    trimmed: 1,
    extended: 1,
    moved: 1,
    unchanged: 1,
    changed: 5,
    hasChanges: true
  });
  assert.equal(result.clips.find((item) => item.before?.id === "trim").changes.sourceDurationDelta, -4);
  assert.equal(result.clips.find((item) => item.before?.id === "extend").changes.sourceDurationDelta, 4);
});

test("matches duplicate clip ids only inside the same source", () => {
  const before = workspace("v1", [
    clip("shot-001", "CAM_A", 0, 4, 0),
    clip("shot-001", "CAM_B", 10, 14, 4)
  ]);
  const after = workspace("v2", [
    clip("shot-001", "CAM_B", 10, 12, 0),
    clip("shot-001", "CAM_A", 0, 4, 2)
  ]);

  const result = compareEditWorkspaces(before, after);
  const cameraB = result.clips.find((item) => item.before?.sourceKey === "CAM_B");
  assert.equal(cameraB.after.sourceKey, "CAM_B");
  assert.equal(cameraB.status, "trimmed");
  assert.equal(cameraB.match, "source-id");
  const cameraA = result.clips.find((item) => item.before?.sourceKey === "CAM_A");
  assert.equal(cameraA.after.sourceKey, "CAM_A");
  assert.equal(cameraA.status, "moved");
});

test("uses the best same-source overlap when clip ids changed", () => {
  const before = workspace("v1", [
    clip("old-wide", "CAM_A", 0, 20, 0),
    clip("old-detail", "CAM_A", 6, 12, 20)
  ]);
  const after = workspace("v2", [
    clip("new-detail", "CAM_A", 7, 11, 0),
    clip("new-wide", "CAM_A", 0, 5, 4)
  ]);

  const result = compareEditWorkspaces(before, after);
  const detail = result.clips.find((item) => item.before?.id === "old-detail");
  assert.equal(detail.after.id, "new-detail");
  assert.equal(detail.match, "source-overlap");
  assert.equal(detail.status, "trimmed");
  const wide = result.clips.find((item) => item.before?.id === "old-wide");
  assert.equal(wide.after.id, "new-wide");
});

test("excluded clips are compared as absent from the current cut", () => {
  const before = workspace("v1", [clip("one", "A", 0, 4, 0)]);
  const after = workspace("v2", [clip("one", "A", 0, 4, 0, { status: "excluded" })]);
  const result = compareEditWorkspaces(before, after);
  assert.equal(result.clips.length, 1);
  assert.equal(result.clips[0].status, "removed");
  assert.equal(result.summary.clips.after, 0);
});

test("compares marker timing and duration while treating a renamed marker as remove plus add", () => {
  const before = workspace("v4", [], [
    { type: "flower", label: "生日主场", time: 1, end: 5 },
    { type: "chapter", label: "第一章", time: 10, end: 20 },
    { type: "sfx", label: "快门", time: 21, end: 21 },
    { type: "bgm", label: "旧音乐", time: 22, end: 30 }
  ]);
  const after = workspace("v5", [], [
    { type: "flower", label: "生日主场", time: 2, end: 4 },
    { type: "chapter", label: "第一章", time: 10, end: 25 },
    { type: "sfx", label: "快门", time: 24, end: 24 },
    { type: "bgm", label: "新音乐", time: 22, end: 30 }
  ]);

  const result = compareEditWorkspaces(before, after);
  assert.equal(result.markers.find((item) => item.before?.label === "生日主场").status, "trimmed");
  assert.equal(result.markers.find((item) => item.before?.label === "第一章").status, "extended");
  assert.equal(result.markers.find((item) => item.before?.label === "快门").status, "moved");
  assert.equal(result.markers.find((item) => item.before?.label === "旧音乐").status, "removed");
  assert.equal(result.markers.find((item) => item.after?.label === "新音乐").status, "added");
  assert.deepEqual(result.summary.markers, {
    before: 4,
    after: 4,
    added: 1,
    removed: 1,
    trimmed: 1,
    extended: 1,
    moved: 1,
    unchanged: 0,
    changed: 5,
    hasChanges: true
  });
  assert.equal(result.summary.changed, 5);
  assert.equal(result.summary.hasChanges, true);
});

test("does not mutate either workspace", () => {
  const before = workspace("v1", [clip("same", "A", 0, 5, 0)]);
  const after = workspace("v2", [clip("same", "A", 0, 5, 0)]);
  const beforeSnapshot = structuredClone(before);
  const afterSnapshot = structuredClone(after);
  compareEditWorkspaces(before, after);
  assert.deepEqual(before, beforeSnapshot);
  assert.deepEqual(after, afterSnapshot);
});
