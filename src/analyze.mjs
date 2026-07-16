const actionReasons = {
  KEEP: "Preserves an essential idea or story beat.",
  CUT: "Removes hesitation, repetition, or low-value material.",
  MOVE: "A strong hook that may work better earlier in the story.",
  "B-ROLL": "A concrete visual could make this moment clearer."
};

function toSeconds(value) {
  const normalized = value.replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return Number(parts[0]) || 0;
}

export function parseTranscript(input) {
  const blocks = input.trim().split(/\n\s*\n/);
  const timed = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => line.includes("-->"));
    if (timeIndex === -1) continue;
    const [from, to] = lines[timeIndex].split("-->").map((part) => part.trim());
    const text = lines.slice(timeIndex + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    if (text) timed.push({ start: toSeconds(from), end: toSeconds(to), text });
  }
  if (timed.length) return timed;

  const sentences = input
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？])\s+/)
    .map((text) => text.trim())
    .filter(Boolean);
  let cursor = 0;
  return sentences.map((text) => {
    const length = Math.max(2.5, Math.min(8, text.split(/\s+/).length / 2.3));
    const segment = { start: cursor, end: cursor + length, text };
    cursor += length;
    return segment;
  });
}

function chooseAction(segment, index, all) {
  const text = segment.text.toLowerCase();
  if (/\b(um+|uh+|sorry|start again|let me restart|i mean)\b|重复|重来|口误/.test(text)) return "CUT";
  const previous = index > 0 ? all[index - 1].text.toLowerCase() : "";
  if (previous && text.replace(/[^a-z0-9\u4e00-\u9fff]/g, "") === previous.replace(/[^a-z0-9\u4e00-\u9fff]/g, "")) return "CUT";
  if (index > 1 && /\b(secret|biggest|surprising|problem|mistake|why|imagine)\b|关键|最重要|问题|想象/.test(text)) return "MOVE";
  if (/\b(screen|chart|map|timeline|camera|before|after|example|workflow)\b|画面|地图|图表|时间线|示例|流程/.test(text)) return "B-ROLL";
  return "KEEP";
}

export function analyzeLocally(input) {
  const segments = parseTranscript(input).slice(0, 80);
  const decisions = segments.map((segment, index) => {
    const action = chooseAction(segment, index, segments);
    return {
      id: `segment-${String(index + 1).padStart(3, "0")}`,
      start: Number(segment.start.toFixed(2)),
      end: Number(segment.end.toFixed(2)),
      text: segment.text,
      action,
      reason: actionReasons[action],
      confidence: action === "KEEP" ? 0.72 : 0.82
    };
  });
  return normalizeDecisions({
    summary: `Reviewed ${decisions.length} transcript segments with the local demo analyzer.`,
    decisions
  });
}

export function normalizeDecisions(result) {
  const allowed = new Set(["KEEP", "CUT", "MOVE", "B-ROLL"]);
  const decisions = Array.isArray(result.decisions) ? result.decisions.slice(0, 80) : [];
  return {
    summary: String(result.summary || "Editorial review complete.").slice(0, 300),
    decisions: decisions.map((item, index) => {
      const action = allowed.has(item.action) ? item.action : "KEEP";
      return {
        id: String(item.id || `segment-${index + 1}`).slice(0, 80),
        start: Math.max(0, Number(item.start) || 0),
        end: Math.max(Number(item.start) || 0, Number(item.end) || 0),
        text: String(item.text || "").slice(0, 600),
        action,
        reason: String(item.reason || actionReasons[action]).slice(0, 300),
        confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0.5)),
        review: "pending"
      };
    })
  };
}
