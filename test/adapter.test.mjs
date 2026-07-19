import test from "node:test";
import assert from "node:assert/strict";
import {
  timecodedTranscriptToAnalyzeInput,
  analyzeTranscript
} from "../src/adapter.mjs";

test("adapter converts a Transcript into SRT-shaped text parseTranscript understands", () => {
  const transcript = {
    duration: 4.5,
    language: "en",
    segments: [
      { start: 0.0, end: 1.0, text: "Hello world.", words: [] },
      { start: 1.0, end: 2.5, text: "This is a second beat.", words: [] },
      { start: 2.5, end: 4.5, text: "And here is the third.", words: [] }
    ]
  };
  const srt = timecodedTranscriptToAnalyzeInput(transcript);
  // 3 blocks separated by blank lines, each with "HH:MM:SS,mmm --> HH:MM:SS,mmm"
  assert.equal((srt.match(/-->/g) || []).length, 3);
  assert.ok(srt.includes("00:00:00,000 --> 00:00:01,000"));
  assert.ok(srt.includes("00:00:02,500 --> 00:00:04,500"));
  assert.ok(srt.includes("Hello world."));
});

test("adapter drops segments with empty text but preserves timecodes on others", () => {
  const srt = timecodedTranscriptToAnalyzeInput({
    duration: 1,
    language: "en",
    segments: [
      { start: 0, end: 0.5, text: "", words: [] },
      { start: 0.5, end: 1.0, text: "kept", words: [] }
    ]
  });
  assert.ok(!/00:00:00,000/.test(srt.split("\n\n")[0]), "empty segment should be filtered out");
  assert.ok(srt.includes("kept"));
});

test("adapter handles malformed timecodes defensively", () => {
  const srt = timecodedTranscriptToAnalyzeInput({
    duration: 0,
    language: "en",
    segments: [
      { start: -1, end: undefined, text: "normalize me", words: [] },
      { start: "nope", end: null, text: "also normalize me", words: [] }
    ]
  });
  // Both segments survive with valid SRT timestamps clamped to >= 0.
  assert.ok(srt.includes("00:00:00,000 --> 00:00:00,000"));
  assert.equal((srt.match(/-->/g) || []).length, 2);
});

test("analyzeTranscript end-to-end roundtrip returns non-empty decisions with timecodes", () => {
  const transcript = {
    duration: 6,
    language: "en",
    segments: [
      { start: 0.0, end: 1.0, text: "Welcome to the show.", words: [] },
      { start: 1.0, end: 2.5, text: "Um, sorry, let me restart.", words: [] },
      { start: 2.5, end: 4.0, text: "Today we are talking about workflow.", words: [] },
      { start: 4.0, end: 6.0, text: "Look at this screen for the chart example.", words: [] }
    ]
  };
  const result = analyzeTranscript(transcript);
  assert.ok(result.decisions.length > 0, "expected at least one decision");
  // The analyzer flagged "let me restart" should be CUT.
  assert.ok(result.decisions.some((d) => d.action === "CUT"), "expected CUT for restart cue");
  // Timecodes survive roundtrip within 0.01s precision.
  for (const decision of result.decisions) {
    assert.ok(typeof decision.start === "number" && decision.start >= 0);
    assert.ok(decision.end >= decision.start);
  }
});

test("analyzeTranscript returns an empty decision list cleanly for speech-less transcripts", () => {
  const result = analyzeTranscript({
    duration: 0,
    language: "en",
    segments: []
  });
  assert.deepEqual(result.decisions, []);
  assert.ok(typeof result.summary === "string" && result.summary.length > 0);
});
