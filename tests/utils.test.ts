import { describe, it, expect } from "vitest";
import {
  formatDuration,
  generatePagination,
  parseTranscript,
  updateURLParams,
  daysAgo,
} from "@/lib/utils";

describe("formatDuration", () => {
  it("formats seconds under a minute", () => {
    expect(formatDuration(45)).toBe("0:45");
    expect(formatDuration(5)).toBe("0:05");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(90)).toBe("1:30");
    expect(formatDuration(600)).toBe("10:00");
  });

  it("formats hours with zero-padded minutes and seconds", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(7200)).toBe("2:00:00");
  });

  it("returns empty string for null, zero, and negatives", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(-5)).toBe("");
  });
});

describe("generatePagination", () => {
  it("lists every page when total is small", () => {
    expect(generatePagination(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(generatePagination(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("collapses the tail when current page is near the start", () => {
    expect(generatePagination(2, 20)).toEqual([1, 2, 3, 4, 5, "...", 20]);
  });

  it("collapses the head when current page is near the end", () => {
    expect(generatePagination(19, 20)).toEqual([
      1,
      "...",
      16,
      17,
      18,
      19,
      20,
    ]);
  });

  it("collapses both sides in the middle", () => {
    expect(generatePagination(10, 20)).toEqual([
      1,
      "...",
      9,
      10,
      11,
      "...",
      20,
    ]);
  });
});

describe("parseTranscript", () => {
  it("parses WebVTT cues into timed entries", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:04.000",
      "Hello world",
      "",
      "00:00:05.000 --> 00:00:08.000",
      "Second cue",
    ].join("\n");

    const result = parseTranscript(vtt);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].time).toBe("00:00:01");
    expect(result[0].text).toContain("Hello world");
  });

  it("returns an empty array for empty input", () => {
    expect(parseTranscript("")).toEqual([]);
    expect(parseTranscript("WEBVTT")).toEqual([]);
  });

  it("ignores bare cue-number lines", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:02.000",
      "Text line",
    ].join("\n");
    const result = parseTranscript(vtt);
    expect(result.every((e) => e.text !== "1")).toBe(true);
  });
});

describe("updateURLParams", () => {
  it("sets new params and preserves existing ones", () => {
    const params = new URLSearchParams("filter=recent");
    const url = updateURLParams(params, { query: "demo" }, "/");
    expect(url).toContain("filter=recent");
    expect(url).toContain("query=demo");
  });

  it("removes params set to null or undefined", () => {
    const params = new URLSearchParams("query=old&filter=recent");
    const url = updateURLParams(params, { query: null }, "/");
    expect(url).not.toContain("query=");
    expect(url).toContain("filter=recent");
  });
});

describe("daysAgo", () => {
  it("says Today for the current time", () => {
    expect(daysAgo(new Date())).toBe("Today");
  });

  it("handles singular and plural days", () => {
    const oneDay = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const threeDays = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 - 3600_000);
    expect(daysAgo(oneDay)).toBe("1 day ago");
    expect(daysAgo(threeDays)).toBe("3 days ago");
  });
});
