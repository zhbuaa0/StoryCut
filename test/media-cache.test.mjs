import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearProjectMediaCache,
  clearMediaCacheSection,
  getFirstFrameThumbnail,
  mediaCacheStatus,
  mediaCacheSettings,
  pruneMediaCache,
  projectMediaCacheStatus,
  resolvePlaybackProxyFile,
  updateMediaCacheSettings,
  waitForPlaybackProxy
} from "../src/media-cache.mjs";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `${command} failed`)));
  });
}

test("playback proxy transcodes to fast-start H.264/AAC and reuses the SSD artifact", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycut-media-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "preview_draft.mov");
  try {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "lavfi", "-i", "testsrc2=s=960x540:r=30:d=1.2",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2",
      "-c:v", "mpeg4", "-q:v", "3", "-c:a", "aac", "-shortest", "-y", source
    ]);
  } catch (error) {
    t.skip(`ffmpeg unavailable: ${error.message}`);
    return;
  }
  const cacheRoot = path.join(root, "cache");
  const first = await waitForPlaybackProxy(source, {
    cacheRoot,
    maxBytes: 4 * 1024 * 1024,
    reserveBytes: 0,
    timeoutMs: 30_000,
    maxEdge: 640,
    videoBitrate: 800_000,
    audioBitrate: 96_000
  });
  assert.equal(first.status, "ready");
  assert.equal(first.percent, 100);
  assert.equal(first.kind, "playback-proxy");
  assert.equal(path.extname(first.filePath), ".mp4");
  const { stdout } = await new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type,codec_name,width,height",
      "-of", "json",
      first.filePath
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout }) : reject(new Error(stderr)));
  });
  const probe = JSON.parse(stdout);
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.width, 640);
  assert.equal(video.height, 360);
  assert.equal(audio.codec_name, "aac");
  const proxyBytes = await fs.readFile(first.filePath);
  assert.equal(proxyBytes.indexOf(Buffer.from("moov")) < proxyBytes.indexOf(Buffer.from("mdat")), true);
  const reused = await waitForPlaybackProxy(source, {
    cacheRoot,
    reserveBytes: 0,
    maxEdge: 640,
    videoBitrate: 800_000,
    audioBitrate: 96_000
  });
  assert.equal(reused.status, "ready");
  assert.equal(reused.filePath, first.filePath);
  assert.equal(await resolvePlaybackProxyFile(`proxy-${reused.cacheId}`, cacheRoot), reused.filePath);
  assert.equal(await resolvePlaybackProxyFile("proxy-not-safe", cacheRoot), null);
  const sourceStat = await fs.stat(source);
  await fs.utimes(source, sourceStat.atime, new Date(sourceStat.mtimeMs + 10_000));
  const invalidated = await waitForPlaybackProxy(source, {
    cacheRoot,
    reserveBytes: 0,
    maxEdge: 640,
    videoBitrate: 800_000,
    audioBitrate: 96_000,
    timeoutMs: 30_000
  });
  assert.equal(invalidated.status, "ready");
  assert.notEqual(invalidated.filePath, first.filePath);
  const pruned = await pruneMediaCache(cacheRoot, { maxBytes: 0 });
  assert.equal(pruned.removedCount, 2);
});

test("first-frame thumbnail is generated as JPEG and reused from disk", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycut-frame-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "clip.mp4");
  try {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=0.4",
      "-pix_fmt", "yuv420p", "-y", source
    ]);
  } catch (error) {
    t.skip(`ffmpeg unavailable: ${error.message}`);
    return;
  }
  const cacheRoot = path.join(root, "cache");
  const first = await getFirstFrameThumbnail(source, { cacheRoot, at: 0.05 });
  const firstStat = await fs.stat(first.filePath);
  assert.equal(path.extname(first.filePath), ".jpg");
  assert.equal(firstStat.size > 100, true);
  assert.equal(first.cacheHit, false);
  const second = await getFirstFrameThumbnail(source, { cacheRoot, at: 0.05 });
  assert.equal(second.filePath, first.filePath);
  assert.equal(second.cacheHit, true);
  const status = await mediaCacheStatus(cacheRoot);
  assert.equal(status.thumbnails.count, 1);
  assert.equal(status.thumbnails.bytes, firstStat.size);
  const cleared = await clearMediaCacheSection("thumbnails", cacheRoot);
  assert.equal(cleared.removedCount, 1);
  assert.equal((await mediaCacheStatus(cacheRoot)).thumbnails.count, 0);
});

test("project cache manifests account for shared artifacts and clear only unreferenced files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycut-project-media-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "clip.mp4");
  try {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "lavfi", "-i", "color=c=green:s=160x90:d=0.4",
      "-pix_fmt", "yuv420p", "-y", source
    ]);
  } catch (error) {
    t.skip(`ffmpeg unavailable: ${error.message}`);
    return;
  }
  const cacheRoot = path.join(root, "cache");
  const projectA = "a".repeat(24);
  const projectB = "b".repeat(24);
  const first = await getFirstFrameThumbnail(source, { cacheRoot, projectId: projectA });
  await getFirstFrameThumbnail(source, { cacheRoot, projectId: projectB });
  assert.equal((await projectMediaCacheStatus(projectA, cacheRoot)).thumbnails.count, 1);
  assert.equal((await projectMediaCacheStatus(projectB, cacheRoot)).thumbnails.count, 1);

  const removedA = await clearProjectMediaCache(projectA, "thumbnails", cacheRoot);
  assert.equal(removedA.thumbnails.removedCount, 0);
  assert.equal(await fs.stat(first.filePath).then(() => true), true);
  assert.equal((await projectMediaCacheStatus(projectA, cacheRoot)).thumbnails.count, 0);
  assert.equal((await projectMediaCacheStatus(projectB, cacheRoot)).thumbnails.count, 1);

  const removedB = await clearProjectMediaCache(projectB, "thumbnails", cacheRoot);
  assert.equal(removedB.thumbnails.removedCount, 1);
  assert.equal(await fs.stat(first.filePath).then(() => true).catch(() => false), false);
});

test("media cache capacity settings persist and enforce safe limits", async (t) => {
  if (process.env.STORYCUT_MEDIA_CACHE_MAX_BYTES) {
    t.skip("capacity is controlled by STORYCUT_MEDIA_CACHE_MAX_BYTES");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "storycut-cache-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const initial = await mediaCacheSettings(root);
  assert.equal(initial.editable, true);
  const updated = await updateMediaCacheSettings(5 * 1024 * 1024 * 1024, root);
  assert.equal(updated.mediaMaxBytes, 5 * 1024 * 1024 * 1024);
  assert.equal((await mediaCacheSettings(root)).source, "settings");
  await assert.rejects(() => updateMediaCacheSettings(512 * 1024 * 1024, root), /1 GB/);
});
