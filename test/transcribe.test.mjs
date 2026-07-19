import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = path.join(repoRoot, "tests", "fixtures", "short.mp3");
const expected = JSON.parse(readFileSync(path.join(repoRoot, "tests", "fixtures", "short.expected.json"), "utf8"));

// Skip integration test in environments without whisper-small-mlx cached or
// when the operator opts out via env var. Pure-function tests already cover
// the shape guarantees; this test exercises the real CLI.
const skipReason = await (async () => {
  if (process.env.STORYCUT_SKIP_TRANSCRIBE_TESTS === "1") return "STORYCUT_SKIP_TRANSCRIBE_TESTS=1";
  try {
    await execFileP("python3", ["-c", "import mlx_whisper"], { timeout: 30_000 });
    return null;
  } catch (error) {
    return `mlx_whisper import failed (${error.code || error.message})`;
  }
})();

test("transcribe: CLI runs on tests/fixtures/short.mp3 and produces a well-formed transcript", {
  skip: skipReason ?? undefined,
  timeout: 180_000
}, async () => {
  const outDir = mkdtempSync(path.join(tmpdir(), "storycut-transcribe-"));
  const result = await new Promise((resolve, reject) => {
    const child = spawn("python3", [
      path.join(repoRoot, "tools", "transcribe.py"),
      "--input", fixture,
      "--language", "en",
      "--output-dir", outDir
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const events = [];
    let buf = "";
    let stderrBuf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch { /* ignore */ }
      }
    });
    child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`CLI exited ${code}\nstderr:\n${stderrBuf}`));
      resolve(events);
    });
  });

  // Stage markers (start -> loading_model -> transcribing -> post_processing -> done)
  const types = result.map((e) => e.type).filter(Boolean);
  const stages = result.filter((e) => e.type === "stage").map((e) => e.stage);
  assert.ok(types.includes("start"), `missing start event in ${JSON.stringify(types)}`);
  assert.ok(stages.includes("loading_model"),
    `missing loading_model stage in ${JSON.stringify(stages)}`);
  assert.ok(stages.includes("transcribing"),
    `missing transcribing stage in ${JSON.stringify(stages)}`);
  assert.ok(types.includes("done"), `missing done event in ${JSON.stringify(types)}`);

  const done = result.find((e) => e.type === "done");
  const transcript = done && done.transcript;

  assert.equal(typeof transcript.id, "string");
  assert.ok(expected.language_in.includes(transcript.language),
    `unexpected language ${transcript.language}; expected one of ${expected.language_in}`);
  assert.ok(transcript.duration >= expected.duration_in[0] &&
            transcript.duration <= expected.duration_in[1],
    `duration ${transcript.duration} not in ${expected.duration_in}`);
  assert.ok(transcript.segments.length >= expected.segments_min,
    `expected at least ${expected.segments_min} segments, got ${transcript.segments.length}`);

  // Aggregate word text across segments for full-transcript assertions.
  const allWords = transcript.segments.flatMap((s) => s.words);
  assert.ok(allWords.length >= expected.words_min, `expected >= ${expected.words_min} words`);
  for (const required of expected.words_in) {
    assert.ok(allWords.some((w) => w.text === required || w.text.startsWith(required.replace(/[,.!?]$/, ""))),
      `expected word "${required}" to appear in transcript`);
  }

  // sample_text_substr: across the joined segment text, the substrings appear.
  const joined = transcript.segments.map((s) => s.text).join(" ");
  for (const needle of expected.sample_text_substr) {
    assert.ok(joined.includes(needle), `expected "${needle}" in transcript text`);
  }
});
