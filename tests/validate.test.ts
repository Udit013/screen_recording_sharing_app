import { describe, it, expect } from "vitest";
import {
  requiredString,
  optionalString,
  clampInt,
  assertVisibility,
  LIMITS,
} from "@/lib/validate";

describe("requiredString", () => {
  it("trims and returns valid input", () => {
    expect(requiredString("  hello  ", "Field", 10)).toBe("hello");
  });

  it("rejects non-strings", () => {
    expect(() => requiredString(42, "Field", 10)).toThrow(
      "Field must be a string"
    );
    expect(() => requiredString(null, "Field", 10)).toThrow();
    expect(() => requiredString(undefined, "Field", 10)).toThrow();
  });

  it("rejects empty and whitespace-only strings", () => {
    expect(() => requiredString("", "Field", 10)).toThrow("cannot be empty");
    expect(() => requiredString("   ", "Field", 10)).toThrow("cannot be empty");
  });

  it("rejects strings over the limit", () => {
    expect(() => requiredString("a".repeat(11), "Field", 10)).toThrow(
      "at most 10"
    );
    expect(requiredString("a".repeat(10), "Field", 10)).toBe("a".repeat(10));
  });
});

describe("optionalString", () => {
  it("returns null for null/undefined/empty", () => {
    expect(optionalString(null, "F", 10)).toBeNull();
    expect(optionalString(undefined, "F", 10)).toBeNull();
    expect(optionalString("   ", "F", 10)).toBeNull();
  });

  it("trims valid input", () => {
    expect(optionalString(" x ", "F", 10)).toBe("x");
  });

  it("rejects non-strings and over-limit strings", () => {
    expect(() => optionalString(5, "F", 10)).toThrow();
    expect(() => optionalString("a".repeat(11), "F", 10)).toThrow();
  });
});

describe("clampInt", () => {
  it("clamps to bounds", () => {
    expect(clampInt(5, 0, 10)).toBe(5);
    expect(clampInt(-3, 0, 10)).toBe(0);
    expect(clampInt(99, 0, 10)).toBe(10);
  });

  it("floors fractional values", () => {
    expect(clampInt(4.9, 0, 10)).toBe(4);
  });

  it("handles junk input by returning the minimum", () => {
    expect(clampInt("abc", 0, 10)).toBe(0);
    expect(clampInt(NaN, 2, 10)).toBe(2);
    expect(clampInt(Infinity, 0, 10)).toBe(0);
    expect(clampInt(undefined, 1, 10)).toBe(1);
  });

  it("coerces numeric strings", () => {
    expect(clampInt("7", 0, 10)).toBe(7);
  });
});

describe("assertVisibility", () => {
  it("accepts the three valid values", () => {
    expect(assertVisibility("public")).toBe("public");
    expect(assertVisibility("private")).toBe("private");
    expect(assertVisibility("link-only")).toBe("link-only");
  });

  it("rejects anything else", () => {
    expect(() => assertVisibility("PUBLIC")).toThrow("Invalid visibility");
    expect(() => assertVisibility("")).toThrow();
    expect(() => assertVisibility(null)).toThrow();
    expect(() => assertVisibility(123)).toThrow();
  });
});

describe("LIMITS", () => {
  it("keeps watch-event ceiling below the timestamp ceiling", () => {
    expect(LIMITS.maxWatchSeconds).toBeLessThanOrEqual(
      LIMITS.maxTimestampSeconds
    );
  });
});
