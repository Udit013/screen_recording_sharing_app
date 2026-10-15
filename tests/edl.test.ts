import { describe, it, expect } from "vitest";
import {
  mergeRanges,
  keptSegments,
  editedDuration,
  sourceToEdited,
  editedToSource,
  nextPlayableTime,
  isInsideCut,
  cutsFromSilences,
  summarizeEdit,
  roundMs,
  clipSegments,
} from "@/lib/media/edl";

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe("mergeRanges", () => {
  it("sorts, merges overlapping and touching ranges", () => {
    expect(mergeRanges([{ start: 5, end: 7 }, { start: 1, end: 2 }, { start: 6, end: 9 }, { start: 2, end: 3 }], 100))
      .toEqual([{ start: 1, end: 3 }, { start: 5, end: 9 }]);
  });

  it("clamps to [0, duration] and drops empty, inverted and non-finite ranges", () => {
    expect(mergeRanges([
      { start: -2, end: 1 }, { start: 8, end: 20 }, { start: 4, end: 4 },
      { start: 6, end: 5 }, { start: NaN, end: 3 }, { start: 2, end: Infinity },
    ], 10)).toEqual([{ start: 0, end: 1 }, { start: 8, end: 10 }]);
  });

  it("does not mutate its input", () => {
    const input = [{ start: 1, end: 3 }, { start: 2, end: 4 }];
    mergeRanges(input, 10);
    expect(input).toEqual([{ start: 1, end: 3 }, { start: 2, end: 4 }]);
  });
});

describe("keptSegments / editedDuration", () => {
  it("is the complement of the cuts", () => {
    expect(keptSegments([{ start: 2, end: 4 }, { start: 7, end: 8 }], 10))
      .toEqual([{ start: 0, end: 2 }, { start: 4, end: 7 }, { start: 8, end: 10 }]);
    close(editedDuration([{ start: 2, end: 4 }, { start: 7, end: 8 }], 10), 7);
  });

  it("handles cuts at the very start and end", () => {
    expect(keptSegments([{ start: 0, end: 1 }, { start: 9, end: 10 }], 10)).toEqual([{ start: 1, end: 9 }]);
  });

  it("returns the whole video with no cuts, and nothing when everything is cut", () => {
    expect(keptSegments([], 10)).toEqual([{ start: 0, end: 10 }]);
    expect(keptSegments([{ start: 0, end: 10 }], 10)).toEqual([]);
    expect(editedDuration([{ start: 0, end: 10 }], 10)).toBe(0);
  });
});

describe("timeline mapping", () => {
  const cuts = mergeRanges([{ start: 2, end: 4 }, { start: 7, end: 8 }], 10);
  const kept = keptSegments(cuts, 10);

  it("maps source time to edited time, collapsing cut regions to their start", () => {
    close(sourceToEdited(1, cuts), 1);
    close(sourceToEdited(3, cuts), 2);     // inside first cut
    close(sourceToEdited(5, cuts), 3);     // 5 - 2 removed
    close(sourceToEdited(7.5, cuts), 5);   // inside second cut
    close(sourceToEdited(10, cuts), 7);
  });

  it("maps edited time back to source time", () => {
    close(editedToSource(0, kept), 0);
    close(editedToSource(2, kept), 4);     // first kept frame after cut 1
    close(editedToSource(4.5, kept), 6.5);
    close(editedToSource(5, kept), 8);
    close(editedToSource(7, kept), 10);    // end clamps to source end
  });

  it("round-trips every kept source time", () => {
    for (let t = 0; t <= 10; t += 0.25) {
      if (isInsideCut(t, cuts)) continue;
      close(editedToSource(sourceToEdited(t, cuts), kept), t);
    }
  });

  it("nextPlayableTime jumps out of cuts and leaves kept time alone", () => {
    expect(nextPlayableTime(1, cuts)).toBe(1);
    expect(nextPlayableTime(2, cuts)).toBe(4);
    expect(nextPlayableTime(3.9, cuts)).toBe(4);
    expect(nextPlayableTime(4, cuts)).toBe(4);
    expect(nextPlayableTime(7.2, cuts)).toBe(8);
  });
});

describe("cutsFromSilences", () => {
  it("keeps padding on both sides and skips pauses too short to cut", () => {
    expect(cutsFromSilences([{ start: 3, end: 6 }, { start: 8, end: 8.3 }], 0.15))
      .toEqual([{ start: 3.15, end: 5.85, reason: "silence" }]);
  });
});

describe("summarizeEdit", () => {
  it("reports removed time and segment count", () => {
    const s = summarizeEdit([{ start: 2, end: 4 }, { start: 3, end: 5 }], 20);
    close(s.editedDuration, 17);
    close(s.removedSeconds, 3);
    close(s.removedFraction, 0.15);
    expect(s.segmentCount).toBe(2);
  });
});

it("roundMs rounds to milliseconds", () => {
  expect(roundMs(1.23456)).toBe(1.235);
  expect(roundMs(0.1 + 0.2)).toBe(0.3);
});

describe("clipSegments", () => {
  const kept = [{ start: 0, end: 2 }, { start: 4, end: 6 }, { start: 8, end: 10 }];

  it("keeps only kept material inside the range", () => {
    expect(clipSegments(kept, { start: 1, end: 9 })).toEqual([
      { start: 1, end: 2 }, { start: 4, end: 6 }, { start: 8, end: 9 },
    ]);
  });

  it("returns nothing when the range lies entirely in a cut", () => {
    expect(clipSegments(kept, { start: 2.5, end: 3.5 })).toEqual([]);
  });

  it("drops slivers below the edit epsilon", () => {
    expect(clipSegments(kept, { start: 1.999, end: 4.001 })).toEqual([]);
  });
});
