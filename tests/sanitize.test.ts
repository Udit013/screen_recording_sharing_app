import { describe, it, expect } from "vitest";
import { sanitizeWords, sanitizeCuts, EDIT_LIMITS } from "@/lib/media/sanitize";

describe("sanitizeWords", () => {
  it("keeps valid words, trims text, rounds to ms and sorts", () => {
    expect(sanitizeWords([
      { text: " world ", start: 1.00049, end: 1.4 },
      { text: "hello", start: 0.2, end: 0.6 },
    ], 10)).toEqual([
      { text: "hello", start: 0.2, end: 0.6 },
      { text: "world", start: 1, end: 1.4 },
    ]);
  });

  it("drops words that are malformed, inverted, negative or past the end", () => {
    const out = sanitizeWords([
      null, "x", { text: 5, start: 0, end: 1 }, { text: "a", start: "0", end: 1 },
      { text: "b", start: 2, end: 1 }, { text: "c", start: -1, end: 1 },
      { text: "d", start: 1, end: 999 }, { text: "  ", start: 1, end: 2 },
      { text: "ok", start: 3, end: 3.5 },
    ], 10);
    expect(out).toEqual([{ text: "ok", start: 3, end: 3.5 }]);
  });

  it("allows small slack past the stored (whole-second) duration", () => {
    expect(sanitizeWords([{ text: "end", start: 36.1, end: 36.4 }], 36)).toHaveLength(1);
  });

  it("caps word length and rejects non-arrays and oversized lists", () => {
    expect(sanitizeWords([{ text: "x".repeat(500), start: 0, end: 1 }], 10)[0].text)
      .toHaveLength(EDIT_LIMITS.maxWordLength);
    expect(() => sanitizeWords({}, 10)).toThrow("array");
    expect(() => sanitizeWords(new Array(EDIT_LIMITS.maxWords + 1).fill(null), 10)).toThrow("too long");
  });
});

describe("sanitizeCuts", () => {
  it("keeps valid cuts of known kinds, sorted, overlaps allowed", () => {
    expect(sanitizeCuts([
      { start: 5, end: 7, reason: "manual" },
      { start: 1, end: 3, reason: "silence" },
      { start: 2, end: 4, reason: "manual" },
    ], 10).map((c) => c.start)).toEqual([1, 2, 5]);
  });

  it("drops unknown reasons, inverted and empty ranges, and clamps to bounds", () => {
    expect(sanitizeCuts([
      { start: 1, end: 2, reason: "evil" },
      { start: 3, end: 2, reason: "manual" },
      { start: 4, end: 4, reason: "manual" },
      { start: -5, end: 1, reason: "manual" },
      { start: 9, end: 500, reason: "silence" },
    ], 10)).toEqual([
      { start: 0, end: 1, reason: "manual" },
      { start: 9, end: 12, reason: "silence" },
    ]);
  });

  it("rejects non-arrays and oversized lists", () => {
    expect(() => sanitizeCuts("nope", 10)).toThrow("array");
    expect(() => sanitizeCuts(new Array(EDIT_LIMITS.maxCuts + 1).fill(null), 10)).toThrow("Too many");
  });
});
