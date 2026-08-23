const DEFAULT_TOLERANCE_SECONDS = 0.05;

export const EDIT_DIFF_STATUSES = Object.freeze([
  "added",
  "removed",
  "trimmed",
  "extended",
  "moved",
  "unchanged"
]);

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value) {
  return String(value ?? "").trim();
}

function rounded(value) {
  return Number(finiteNumber(value).toFixed(3));
}

function clipSourceKey(item) {
  return text(item?.sourceKey ?? item?.source ?? item?.assetId ?? item?.asset ?? item?.sourceName);
}

function includedClips(workspace) {
  return (Array.isArray(workspace?.clips) ? workspace.clips : [])
    .filter((item) => item && item.status !== "excluded" && item.enabled !== false && item.exclude !== true)
    .map((item, order) => {
      const sourceIn = finiteNumber(item.sourceIn ?? item.source_in ?? item.start ?? item.in, 0);
      const declaredSourceOut = item.sourceOut ?? item.source_out ?? item.end ?? item.out;
      const sourceOut = finiteNumber(declaredSourceOut, sourceIn + finiteNumber(item.duration, 0));
      const timelineIn = finiteNumber(item.timelineIn ?? item.timeline_in, 0);
      const timelineOut = finiteNumber(
        item.timelineOut ?? item.timeline_out,
        timelineIn + finiteNumber(item.duration, Math.max(0, sourceOut - sourceIn))
      );
      return {
        item,
        order,
        id: text(item.id),
        sourceKey: clipSourceKey(item),
        sourceIn: Math.min(sourceIn, sourceOut),
        sourceOut: Math.max(sourceIn, sourceOut),
        timelineIn: Math.min(timelineIn, timelineOut),
        timelineOut: Math.max(timelineIn, timelineOut),
        index: finiteNumber(item.index, order)
      };
    });
}

function normalizedMarkers(workspace) {
  const markers = Array.isArray(workspace?.timeline?.markers)
    ? workspace.timeline.markers
    : Array.isArray(workspace?.markers)
      ? workspace.markers
      : [];
  return markers.flatMap((item, order) => {
    if (!item) return [];
    const start = Number(item.time ?? item.start ?? item.timelineIn ?? item.timeline_in);
    if (!Number.isFinite(start)) return [];
    const duration = Math.max(0, finiteNumber(item.duration, 0));
    const declaredEnd = item.end ?? item.timelineOut ?? item.timeline_out;
    const end = finiteNumber(declaredEnd, start + duration);
    return [{
      item,
      order,
      id: text(item.id),
      type: text(item.type || item.kind || "marker").toLowerCase(),
      label: text(item.label ?? item.title ?? item.text),
      source: text(item.source),
      start: Math.min(start, end),
      end: Math.max(start, end)
    }];
  });
}

function intervalMetrics(aStart, aEnd, bStart, bEnd) {
  const aDuration = Math.max(0, aEnd - aStart);
  const bDuration = Math.max(0, bEnd - bStart);
  const overlap = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  const union = Math.max(aEnd, bEnd) - Math.min(aStart, bStart);
  const shorter = Math.min(aDuration, bDuration);
  return {
    overlap,
    iou: union > 0 ? overlap / union : aStart === bStart ? 1 : 0,
    shorterCoverage: shorter > 0 ? overlap / shorter : aStart === bStart ? 1 : 0,
    distance: overlap > 0 ? 0 : Math.max(aStart, bStart) - Math.min(aEnd, bEnd),
    durationDelta: Math.abs(aDuration - bDuration)
  };
}

function compareCandidates(a, b) {
  return b.metrics.iou - a.metrics.iou
    || b.metrics.shorterCoverage - a.metrics.shorterCoverage
    || b.metrics.overlap - a.metrics.overlap
    || a.metrics.distance - b.metrics.distance
    || a.metrics.durationDelta - b.metrics.durationDelta
    || a.positionDelta - b.positionDelta
    || a.before.order - b.before.order
    || a.after.order - b.after.order;
}

function takePairs(candidates, usedBefore, usedAfter, matches, matchKind) {
  candidates.sort(compareCandidates);
  for (const candidate of candidates) {
    if (usedBefore.has(candidate.before.order) || usedAfter.has(candidate.after.order)) continue;
    usedBefore.add(candidate.before.order);
    usedAfter.add(candidate.after.order);
    matches.push({ before: candidate.before, after: candidate.after, match: matchKind });
  }
}

function matchClips(before, after) {
  const usedBefore = new Set();
  const usedAfter = new Set();
  const matches = [];
  const exactCandidates = [];

  for (const oldClip of before) {
    if (!oldClip.id) continue;
    for (const newClip of after) {
      if (oldClip.sourceKey !== newClip.sourceKey || oldClip.id !== newClip.id) continue;
      exactCandidates.push({
        before: oldClip,
        after: newClip,
        metrics: intervalMetrics(oldClip.sourceIn, oldClip.sourceOut, newClip.sourceIn, newClip.sourceOut),
        positionDelta: Math.abs(oldClip.timelineIn - newClip.timelineIn)
      });
    }
  }
  takePairs(exactCandidates, usedBefore, usedAfter, matches, "source-id");

  const overlapCandidates = [];
  for (const oldClip of before) {
    if (usedBefore.has(oldClip.order) || !oldClip.sourceKey) continue;
    for (const newClip of after) {
      if (usedAfter.has(newClip.order) || oldClip.sourceKey !== newClip.sourceKey) continue;
      const metrics = intervalMetrics(oldClip.sourceIn, oldClip.sourceOut, newClip.sourceIn, newClip.sourceOut);
      if (metrics.overlap <= 0) continue;
      overlapCandidates.push({
        before: oldClip,
        after: newClip,
        metrics,
        positionDelta: Math.abs(oldClip.timelineIn - newClip.timelineIn)
      });
    }
  }
  takePairs(overlapCandidates, usedBefore, usedAfter, matches, "source-overlap");

  return { matches, usedBefore, usedAfter };
}

function markerKey(marker) {
  if (marker.id) return `${marker.type}\u0000id:${marker.id}`;
  if (marker.label) return `${marker.type}\u0000label:${marker.label.toLocaleLowerCase()}`;
  return "";
}

function matchMarkers(before, after) {
  const usedBefore = new Set();
  const usedAfter = new Set();
  const matches = [];
  const candidates = [];
  for (const oldMarker of before) {
    const oldKey = markerKey(oldMarker);
    if (!oldKey) continue;
    for (const newMarker of after) {
      if (oldKey !== markerKey(newMarker)) continue;
      candidates.push({
        before: oldMarker,
        after: newMarker,
        metrics: intervalMetrics(oldMarker.start, oldMarker.end, newMarker.start, newMarker.end),
        positionDelta: Math.abs(oldMarker.start - newMarker.start)
      });
    }
  }
  takePairs(candidates, usedBefore, usedAfter, matches, "type-identity");
  return { matches, usedBefore, usedAfter };
}

function changed(a, b, tolerance) {
  return Math.abs(a - b) > tolerance;
}

function clipDifference(before, after, match, tolerance) {
  if (!before) return baseDifference("clip", "added", null, after.item, null);
  if (!after) return baseDifference("clip", "removed", before.item, null, null);

  const beforeSourceDuration = before.sourceOut - before.sourceIn;
  const afterSourceDuration = after.sourceOut - after.sourceIn;
  const beforeTimelineDuration = before.timelineOut - before.timelineIn;
  const afterTimelineDuration = after.timelineOut - after.timelineIn;
  const sourceRangeChanged = changed(before.sourceIn, after.sourceIn, tolerance)
    || changed(before.sourceOut, after.sourceOut, tolerance);
  const timelineRangeChanged = changed(before.timelineIn, after.timelineIn, tolerance)
    || changed(before.timelineOut, after.timelineOut, tolerance);
  const sourceDurationDelta = afterSourceDuration - beforeSourceDuration;
  const timelineDurationDelta = afterTimelineDuration - beforeTimelineDuration;
  const effectiveDurationDelta = sourceRangeChanged ? sourceDurationDelta : timelineDurationDelta;
  const moved = changed(before.timelineIn, after.timelineIn, tolerance)
    || (sourceRangeChanged && Math.abs(sourceDurationDelta) <= tolerance)
    || before.index !== after.index;
  const status = effectiveDurationDelta < -tolerance
    ? "trimmed"
    : effectiveDurationDelta > tolerance
      ? "extended"
      : moved || sourceRangeChanged || timelineRangeChanged
        ? "moved"
        : "unchanged";

  return {
    ...baseDifference("clip", status, before.item, after.item, match),
    changes: {
      sourceRangeChanged,
      timelineRangeChanged,
      sourcePositionChanged: changed(before.sourceIn, after.sourceIn, tolerance),
      timelinePositionChanged: changed(before.timelineIn, after.timelineIn, tolerance),
      indexChanged: before.index !== after.index,
      sourceDurationDelta: rounded(sourceDurationDelta),
      timelineDurationDelta: rounded(timelineDurationDelta)
    }
  };
}

function markerDifference(before, after, match, tolerance) {
  if (!before) return baseDifference("marker", "added", null, after.item, null);
  if (!after) return baseDifference("marker", "removed", before.item, null, null);
  const beforeDuration = before.end - before.start;
  const afterDuration = after.end - after.start;
  const durationDelta = afterDuration - beforeDuration;
  const positionChanged = changed(before.start, after.start, tolerance);
  const endChanged = changed(before.end, after.end, tolerance);
  const status = durationDelta < -tolerance
    ? "trimmed"
    : durationDelta > tolerance
      ? "extended"
      : positionChanged || endChanged
        ? "moved"
        : "unchanged";
  return {
    ...baseDifference("marker", status, before.item, after.item, match),
    changes: {
      positionChanged,
      endChanged,
      durationDelta: rounded(durationDelta),
      sourceChanged: before.source !== after.source
    }
  };
}

function baseDifference(kind, status, before, after, match) {
  return {
    kind,
    status,
    match,
    before,
    after
  };
}

function differenceTime(item) {
  const value = item.after || item.before || {};
  return finiteNumber(value.timelineIn ?? value.timeline_in ?? value.time ?? value.start, 0);
}

function sortDifferences(items) {
  const order = new Map(EDIT_DIFF_STATUSES.map((status, index) => [status, index]));
  return items.sort((a, b) => differenceTime(a) - differenceTime(b)
    || (order.get(a.status) ?? 99) - (order.get(b.status) ?? 99));
}

function summarize(items, beforeCount, afterCount) {
  const counts = Object.fromEntries(EDIT_DIFF_STATUSES.map((status) => [status, 0]));
  for (const item of items) counts[item.status] += 1;
  const changedCount = items.length - counts.unchanged;
  return {
    before: beforeCount,
    after: afterCount,
    ...counts,
    changed: changedCount,
    hasChanges: changedCount > 0
  };
}

/**
 * Compare two serializable objects returned by buildEditWorkspace().
 *
 * The comparison is pure: inputs are never changed. Clips first match by the
 * composite sourceKey + id identity, then by overlapping source intervals on
 * the same source. Markers match by type + id, or type + label when no id is
 * available.
 */
export function compareEditWorkspaces(beforeWorkspace, afterWorkspace, options = {}) {
  const tolerance = Math.max(0, finiteNumber(options.tolerance, DEFAULT_TOLERANCE_SECONDS));
  const beforeClips = includedClips(beforeWorkspace);
  const afterClips = includedClips(afterWorkspace);
  const clipMatches = matchClips(beforeClips, afterClips);
  const clips = clipMatches.matches.map(({ before, after, match }) => clipDifference(before, after, match, tolerance));
  for (const item of beforeClips) {
    if (!clipMatches.usedBefore.has(item.order)) clips.push(clipDifference(item, null, null, tolerance));
  }
  for (const item of afterClips) {
    if (!clipMatches.usedAfter.has(item.order)) clips.push(clipDifference(null, item, null, tolerance));
  }

  const beforeMarkers = normalizedMarkers(beforeWorkspace);
  const afterMarkers = normalizedMarkers(afterWorkspace);
  const markerMatches = matchMarkers(beforeMarkers, afterMarkers);
  const markers = markerMatches.matches.map(({ before, after, match }) => markerDifference(before, after, match, tolerance));
  for (const item of beforeMarkers) {
    if (!markerMatches.usedBefore.has(item.order)) markers.push(markerDifference(item, null, null, tolerance));
  }
  for (const item of afterMarkers) {
    if (!markerMatches.usedAfter.has(item.order)) markers.push(markerDifference(null, item, null, tolerance));
  }

  sortDifferences(clips);
  sortDifferences(markers);
  const clipSummary = summarize(clips, beforeClips.length, afterClips.length);
  const markerSummary = summarize(markers, beforeMarkers.length, afterMarkers.length);
  return {
    fromVersion: beforeWorkspace?.activeVersion || beforeWorkspace?.timeline?.versionId || null,
    toVersion: afterWorkspace?.activeVersion || afterWorkspace?.timeline?.versionId || null,
    clips,
    markers,
    summary: {
      clips: clipSummary,
      markers: markerSummary,
      changed: clipSummary.changed + markerSummary.changed,
      hasChanges: clipSummary.hasChanges || markerSummary.hasChanges
    }
  };
}
