// StoryCut analyzer adapter: bridges the new timecoded Transcript shape
// (from tools/transcribe.py) into v0.1's parseTranscript input format.
//
// We DO NOT modify v0.1's parser — instead we serialize the new shape into
// SRT-flavored text that parseTranscript already understands. The analyzer's
// decisions are based on segment text + index, so feeding through SRT preserves
// timecode alignment without touching the existing engine.

import { analyzeLocally, parseTranscript, normalizeDecisions } from "./analyze.mjs";

/**
 * Convert a Transcript (FR-3.1 shape) into an SRT-ish string parseTranscript can read.
 *
 * Each segment becomes one block:
 *
 *     1
 *     HH:MM:SS,mmm --> HH:MM:SS,mmm
 *     <segment text>
 *
 * The leading index is decorative — parseTranscript doesn't require it — but
 * having one keeps the output spec-compliant and easier to debug by eye.
 *
 * Empty text segments are skipped (parseTranscript drops them anyway).
 *
 * @param {object} transcript - { duration: number, language: string, segments: Segment[] }
 * @returns {string} SRT-style text consumable by parseTranscript / analyzeLocally
 */
export function timecodedTranscriptToAnalyzeInput(transcript) {
  const segments = Array.isArray(transcript?.segments) ? transcript.segments : [];
  const blocks = [];
  let index = 1;
  for (const segment of segments) {
    const text = String(segment?.text || "").trim();
    if (!text) continue;
    const start = clampSeconds(segment?.start);
    const end = clampSeconds(Math.max(segment?.end ?? start, start));
    blocks.push(`${index}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${text}`);
    index += 1;
  }
  return blocks.join("\n\n");
}

/**
 * Run v0.1's analyzer over a Transcript shape via the adapter.
 * Returns the same {summary, decisions} shape analyzeLocally returns.
 *
 * @param {object} transcript
 * @returns {{summary: string, decisions: object[]}}
 */
export function analyzeTranscript(transcript) {
  const input = timecodedTranscriptToAnalyzeInput(transcript);
  if (!input.trim()) {
    return normalizeDecisions({ summary: "Transcript had no segments to analyze.", decisions: [] });
  }
  return analyzeLocally(input);
}

function clampSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function formatSrtTimestamp(seconds) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const wholeSeconds = Math.floor(safe % 60);
  const milliseconds = Math.round((safe - Math.floor(safe)) * 1000);
  // Roll overflow when rounding ms pushes us to a new second.
  let carry = 0;
  let ms = milliseconds;
  if (ms >= 1000) {
    carry = Math.floor(ms / 1000);
    ms = ms % 1000;
  }
  const totalSeconds = wholeSeconds + carry;
  const secRolled = ((totalSeconds % 60) + 60) % 60;
  const minuteRolled = (minutes + Math.floor(totalSeconds / 60)) % 60;
  const hourRolled = hours + Math.floor((minutes + Math.floor(totalSeconds / 60)) / 60);
  return (
    `${String(hourRolled).padStart(2, "0")}:` +
    `${String(minuteRolled).padStart(2, "0")}:` +
    `${String(secRolled).padStart(2, "0")},` +
    `${String(ms).padStart(3, "0")}`
  );
}

// Re-export the imported v0.1 functions so callers can rely on this module as a
// stable entry point: `import { timecodedTranscriptToAnalyzeInput, analyzeLocally }
// from './src/adapter.mjs'` keeps the import surface narrow.
export { analyzeLocally, parseTranscript, normalizeDecisions };
