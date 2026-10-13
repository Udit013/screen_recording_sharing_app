// Edit Decision List (EDL) — the non-destructive editing model.
//
// The source video is never modified. An edit is a list of time ranges to
// skip ("cuts"), in SOURCE seconds. Everything else — preview playback, the
// edited timeline shown to viewers, and the rendered export — is derived from
// that list by the pure functions below.
//
// Keeping cuts in source time is what lets comments, notes, chapters and
// analytics (all stored in source time) survive any number of re-edits.
//
// Cuts are stored UNMERGED, each with the reason it exists, so toggling one
// layer (e.g. "remove pauses") off never disturbs cuts the user made by hand.
// Merging happens only when deriving playable segments.

export type CutReason = "manual" | "silence";

export interface Range {
  start: number;
  end: number;
}

export interface Cut extends Range {
  reason: CutReason;
}

/** Ranges shorter than this are noise from float math, not edits. */
const EPSILON = 0.005;

/** Round to milliseconds so stored values don't accumulate float noise. */
export const roundMs = (t: number): number => Math.round(t * 1000) / 1000;

/**
 * Clamps ranges to [0, duration], drops empty/invalid ones, sorts, and merges
 * any that overlap or touch. The result is the canonical set of skipped time.
 * O(n log n).
 */
export function mergeRanges(ranges: Range[], duration: number): Range[] {
  const clamped = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r) => ({
      start: Math.max(0, Math.min(duration, r.start)),
      end: Math.max(0, Math.min(duration, r.end)),
    }))
    .filter((r) => r.end - r.start > EPSILON)
    .sort((a, b) => a.start - b.start);

  const merged: Range[] = [];
  for (const r of clamped) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end + EPSILON) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

/** The complement of the cuts: source ranges that survive the edit, in order. */
export function keptSegments(cuts: Range[], duration: number): Range[] {
  const merged = mergeRanges(cuts, duration);
  const kept: Range[] = [];
  let cursor = 0;
  for (const c of merged) {
    if (c.start - cursor > EPSILON) kept.push({ start: cursor, end: c.start });
    cursor = c.end;
  }
  if (duration - cursor > EPSILON) kept.push({ start: cursor, end: duration });
  return kept;
}

export function editedDuration(cuts: Range[], duration: number): number {
  return keptSegments(cuts, duration).reduce((s, r) => s + (r.end - r.start), 0);
}

/**
 * Maps a source time onto the edited timeline. A time that falls inside a cut
 * maps to the point where that cut was removed. `merged` must be the output of
 * mergeRanges. O(cuts).
 */
export function sourceToEdited(t: number, merged: Range[]): number {
  let removed = 0;
  for (const c of merged) {
    if (t >= c.end) removed += c.end - c.start;
    else if (t > c.start) return c.start - removed;
    else break;
  }
  return Math.max(0, t - removed);
}

/**
 * Inverse of sourceToEdited: maps an edited-timeline position back to the
 * source time that plays there. `kept` must be the output of keptSegments.
 */
export function editedToSource(t: number, kept: Range[]): number {
  let offset = 0;
  for (const seg of kept) {
    const len = seg.end - seg.start;
    if (t < offset + len) return seg.start + Math.max(0, t - offset);
    offset += len;
  }
  const last = kept[kept.length - 1];
  return last ? last.end : 0;
}

/**
 * Where playback should actually be when it reaches source time `t`: inside a
 * cut it jumps to the cut's end, otherwise it stays put. Used by the preview
 * and viewer players to skip removed material in real time.
 */
export function nextPlayableTime(t: number, merged: Range[]): number {
  for (const c of merged) {
    if (t < c.start - EPSILON) return t;
    if (t < c.end - EPSILON) return c.end;
  }
  return t;
}

/** True when `t` lies inside removed material. */
export function isInsideCut(t: number, merged: Range[]): boolean {
  return merged.some((c) => t >= c.start && t < c.end);
}

/**
 * Turns detected silences into cuts, keeping `padding` seconds of quiet on each
 * side so the edit breathes instead of jump-cutting mid-breath. Silences that
 * would leave a cut shorter than `minCut` are left alone.
 */
export function cutsFromSilences(
  silences: Range[],
  padding: number,
  minCut = 0.15
): Cut[] {
  const cuts: Cut[] = [];
  for (const s of silences) {
    const start = roundMs(s.start + padding);
    const end = roundMs(s.end - padding);
    if (end - start >= minCut) cuts.push({ start, end, reason: "silence" });
  }
  return cuts;
}

export interface EditSummary {
  sourceDuration: number;
  editedDuration: number;
  removedSeconds: number;
  removedFraction: number;
  segmentCount: number;
}

export function summarizeEdit(cuts: Range[], duration: number): EditSummary {
  const kept = keptSegments(cuts, duration);
  const edited = kept.reduce((s, r) => s + (r.end - r.start), 0);
  return {
    sourceDuration: duration,
    editedDuration: edited,
    removedSeconds: duration - edited,
    removedFraction: duration > 0 ? (duration - edited) / duration : 0,
    segmentCount: kept.length,
  };
}

/**
 * Restores `range`: removes it from every cut, splitting cuts that only
 * partially overlap it. Used by "restore" in the transcript and timeline.
 */
export function subtractRange(cuts: Cut[], range: Range): Cut[] {
  const out: Cut[] = [];
  for (const c of cuts) {
    if (c.end <= range.start || c.start >= range.end) {
      out.push(c);
      continue;
    }
    if (c.start < range.start - EPSILON) out.push({ ...c, end: roundMs(range.start) });
    if (c.end > range.end + EPSILON) out.push({ ...c, start: roundMs(range.end) });
  }
  return out;
}
