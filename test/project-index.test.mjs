import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearProjectIndexCache,
  clearProjectIndexCacheFor,
  inspectProjectIndexed,
  projectSessionId,
  restoreProjectIndexed,
  projectIndexCacheStatus,
  projectIndexCacheStatusFor
} from "../src/project-index.mjs";

async function indexedFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycut-index-project-"));
  const edit = path.join(root, "edit");
  const version = path.join(edit, "rough_cut_v1_r1");
  const cacheRoot = path.join(root, "cache", "project-index");
  await fs.mkdir(version, { recursive: true });
  await fs.writeFile(path.join(edit, "project.md"), "# Indexed project\n", "utf8");
  await fs.writeFile(path.join(version, "preview.mp4"), "preview-placeholder", "utf8");
  await fs.writeFile(path.join(version, "master.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHello\n", "utf8");
  await fs.writeFile(path.join(version, "edl.json"), JSON.stringify({ ranges: [] }), "utf8");
  await fs.writeFile(path.join(edit, "storycut_manifest.json"), JSON.stringify({
    activeVersion: "rough_cut_v1_r1",
    versions: [{ id: "rough_cut_v1_r1", label: "R1" }],
    active: {
      preview: "rough_cut_v1_r1/preview.mp4",
      edl: "rough_cut_v1_r1/edl.json",
      subtitle: "rough_cut_v1_r1/master.srt"
    }
  }), "utf8");
  return { root, edit, version, cacheRoot };
}

test("persistent project index reuses a stable inspection and invalidates active files", async (t) => {
  const fixture = await indexedFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const first = await inspectProjectIndexed(fixture.root, { cacheRoot: fixture.cacheRoot });
  assert.equal(first.index.cacheHit, false);
  assert.equal(first.project.activeVersion, "rough_cut_v1_r1");

  const second = await inspectProjectIndexed(fixture.root, { cacheRoot: fixture.cacheRoot });
  assert.equal(second.index.cacheHit, true);
  assert.equal(second.project.preview.relativePath, "rough_cut_v1_r1/preview.mp4");
  assert.equal(second.fileMap.get(second.project.preview.id), path.join(fixture.version, "preview.mp4"));
  const restored = await restoreProjectIndexed(projectSessionId(fixture.root), { cacheRoot: fixture.cacheRoot });
  assert.equal(restored.projectRoot, fixture.root);
  assert.equal(restored.project.preview.relativePath, "rough_cut_v1_r1/preview.mp4");
  assert.equal(await restoreProjectIndexed("not-a-session", { cacheRoot: fixture.cacheRoot }), null);

  await fs.writeFile(path.join(fixture.version, "edl.json"), JSON.stringify({ ranges: [{ id: "new" }] }), "utf8");
  const invalidated = await inspectProjectIndexed(fixture.root, { cacheRoot: fixture.cacheRoot });
  assert.equal(invalidated.index.cacheHit, false);

  const refreshed = await inspectProjectIndexed(fixture.root, { cacheRoot: fixture.cacheRoot, refresh: true });
  assert.equal(refreshed.index.mode, "refreshed");
  const status = await projectIndexCacheStatus(fixture.cacheRoot);
  assert.equal(status.count, 1);
  assert.equal(status.bytes > 0, true);
  const projectId = projectSessionId(fixture.root);
  assert.equal((await projectIndexCacheStatusFor(projectId, fixture.cacheRoot)).count, 1);
  const projectCleared = await clearProjectIndexCacheFor(projectId, fixture.cacheRoot);
  assert.equal(projectCleared.removedCount, 1);
  assert.equal((await projectIndexCacheStatusFor(projectId, fixture.cacheRoot)).count, 0);
  await inspectProjectIndexed(fixture.root, { cacheRoot: fixture.cacheRoot });
  const cleared = await clearProjectIndexCache(fixture.cacheRoot);
  assert.equal(cleared.removedCount, 1);
  assert.equal((await projectIndexCacheStatus(fixture.cacheRoot)).count, 0);
});
