import { describe, it, expect } from "vitest";
import { subtractRange, type Cut } from "@/lib/media/edl";
import { historyReducer, MAX_HISTORY, type History } from "@/lib/media/history";
import { pauseCuts, PAUSE_LEVELS, isPauseLevel } from "@/lib/media/pauses";

const m = (start: number, end: number): Cut => ({ start, end, reason: "manual" });

describe("subtractRange", () => {
  it("removes a cut entirely inside the range", () => {
    expect(subtractRange([m(2, 3)], { start: 1, end: 4 })).toEqual([]);
  });
  it("splits a cut that contains the range", () => {
    expect(subtractRange([m(1, 9)], { start: 4, end: 5 })).toEqual([m(1, 4), m(5, 9)]);
  });
  it("trims partial overlaps and keeps the cut's reason", () => {
    const s: Cut = { start: 1, end: 5, reason: "silence" };
    expect(subtractRange([s], { start: 3, end: 8 })).toEqual([{ start: 1, end: 3, reason: "silence" }]);
  });
  it("leaves unrelated cuts alone", () => {
    expect(subtractRange([m(0, 1), m(8, 9)], { start: 3, end: 5 })).toEqual([m(0, 1), m(8, 9)]);
  });
});

describe("historyReducer", () => {
  const empty: History = { past: [], present: [], future: [] };

  it("commits, undoes and redoes", () => {
    let h = historyReducer(empty, { type: "commit", cuts: [m(1, 2)] });
    h = historyReducer(h, { type: "commit", cuts: [m(1, 2), m(3, 4)] });
    h = historyReducer(h, { type: "undo" });
    expect(h.present).toEqual([m(1, 2)]);
    h = historyReducer(h, { type: "redo" });
    expect(h.present).toEqual([m(1, 2), m(3, 4)]);
  });

  it("drops the redo stack on a new commit", () => {
    let h = historyReducer(empty, { type: "commit", cuts: [m(1, 2)] });
    h = historyReducer(h, { type: "undo" });
    h = historyReducer(h, { type: "commit", cuts: [m(5, 6)] });
    expect(h.future).toEqual([]);
  });

  it("ignores no-op commits and out-of-range undo/redo", () => {
    expect(historyReducer(empty, { type: "commit", cuts: [] })).toBe(empty);
    expect(historyReducer(empty, { type: "undo" })).toBe(empty);
    expect(historyReducer(empty, { type: "redo" })).toBe(empty);
  });

  it("bounds history length", () => {
    let h = empty;
    for (let i = 0; i < MAX_HISTORY + 20; i++) h = historyReducer(h, { type: "commit", cuts: [m(i, i + 0.5)] });
    expect(h.past.length).toBe(MAX_HISTORY);
  });

  it("reset clears both stacks", () => {
    let h = historyReducer(empty, { type: "commit", cuts: [m(1, 2)] });
    h = historyReducer(h, { type: "reset", cuts: [m(7, 8)] });
    expect(h).toEqual({ past: [], present: [m(7, 8)], future: [] });
  });
});

describe("pauseCuts", () => {
  const silences = [{ start: 1, end: 1.6 }, { start: 3, end: 4 }, { start: 6, end: 8 }];

  it("filters by the level's minimum pause and applies its padding", () => {
    expect(pauseCuts(silences, "gentle")).toEqual([{ start: 6.3, end: 7.7, reason: "silence" }]);
    expect(pauseCuts(silences, "balanced").map((c) => c.start)).toEqual([3.2, 6.2]);
    expect(pauseCuts(silences, "tight").map((c) => c.start)).toEqual([1.12, 3.12, 6.12]);
  });

  it("tighter levels never remove less time", () => {
    const total = (l: keyof typeof PAUSE_LEVELS) => pauseCuts(silences, l).reduce((s, c) => s + c.end - c.start, 0);
    expect(total("tight")).toBeGreaterThanOrEqual(total("balanced"));
    expect(total("balanced")).toBeGreaterThanOrEqual(total("gentle"));
  });

  it("validates level names", () => {
    expect(isPauseLevel("tight")).toBe(true);
    expect(isPauseLevel("extreme")).toBe(false);
  });
});
