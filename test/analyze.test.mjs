import test from "node:test";
import assert from "node:assert/strict";
import { analyzeLocally, normalizeDecisions, parseTranscript } from "../src/analyze.mjs";

test("parses SRT timestamps and text", () => {
  const result = parseTranscript(`1\n00:00:01,500 --> 00:00:04,000\nHello world.\n\n2\n00:00:04,000 --> 00:00:06,000\nNext idea.`);
  assert.equal(result.length, 2);
  assert.equal(result[0].start, 1.5);
  assert.equal(result[1].text, "Next idea.");
});

test("local analyzer flags an explicit restart as CUT", () => {
  const result = analyzeLocally("This is the opening. Um, sorry, let me restart. This is the real explanation.");
  assert.ok(result.decisions.some((item) => item.action === "CUT"));
});

test("normalization constrains unsafe or invalid values", () => {
  const result = normalizeDecisions({
    summary: "done",
    decisions: [{ id: "x", start: -10, end: -2, text: "test", action: "DELETE", reason: "", confidence: 7 }]
  });
  assert.equal(result.decisions[0].action, "KEEP");
  assert.equal(result.decisions[0].start, 0);
  assert.equal(result.decisions[0].confidence, 1);
  assert.equal(result.decisions[0].review, "pending");
});
