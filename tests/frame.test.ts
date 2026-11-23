import { describe, expect, it } from "vitest";
import { adjustFilter, defaultLook, drawFrame, isIdentityLook, outputSize, placement, sanitizeLook, type VideoLook } from "@/lib/studio/frame";

const look = (patch: Partial<VideoLook>): VideoLook => ({ ...defaultLook(), ...patch });

describe("output size", () => {
  it("keeps the source shape and size by default", () => {
    expect(outputSize(1920, 1080, defaultLook(), null)).toEqual({ width: 1920, height: 1080 });
    expect(outputSize(1920, 1080, defaultLook(), 720)).toEqual({ width: 1280, height: 720 });
  });

  it("makes presets the right shape, bounding the short side", () => {
    expect(outputSize(1920, 1080, look({ aspect: "9:16" }), 1080)).toEqual({ width: 1080, height: 1920 });
    expect(outputSize(1920, 1080, look({ aspect: "9:16" }), 720)).toEqual({ width: 720, height: 1280 });
    expect(outputSize(1920, 1080, look({ aspect: "1:1" }), null)).toEqual({ width: 1080, height: 1080 });
    expect(outputSize(1920, 1080, look({ aspect: "4:5" }), null)).toEqual({ width: 1080, height: 1350 });
    expect(outputSize(1080, 1920, look({ aspect: "16:9" }), null)).toEqual({ width: 1920, height: 1080 });
  });

  it("never exceeds the source's resolution, and is always even", () => {
    const s = outputSize(1281, 721, look({ aspect: "1:1" }), 1080);
    expect(s.width).toBe(722);
    expect(s.width % 2 + s.height % 2).toBe(0);
  });

  it("follows the crop's shape when the aspect is original", () => {
    expect(outputSize(1920, 1080, look({ crop: { x: 0.25, y: 0, w: 0.5, h: 1 } }), null)).toEqual({ width: 960, height: 1080 });
  });
});

describe("placement", () => {
  it("fill cuts a centred window of the output's shape", () => {
    const { src, dst } = placement(1920, 1080, look({ aspect: "9:16" }), 1080, 1920, "fill");
    expect(dst).toEqual({ x: 0, y: 0, w: 1080, h: 1920 });
    expect(src.h).toBeCloseTo(1080, 6);
    expect(src.w).toBeCloseTo(607.5, 6); // 1080 × 9/16
    expect(src.x).toBeCloseTo((1920 - 607.5) / 2, 6);
  });

  it("fill follows the focus point to the edges", () => {
    const left = placement(1920, 1080, look({ aspect: "9:16", focusX: 0 }), 1080, 1920, "fill");
    const right = placement(1920, 1080, look({ aspect: "9:16", focusX: 1 }), 1080, 1920, "fill");
    expect(left.src.x).toBe(0);
    expect(right.src.x + right.src.w).toBeCloseTo(1920, 6);
  });

  it("fit shows the whole crop, centred, with bars", () => {
    const { src, dst } = placement(1920, 1080, look({ aspect: "9:16", fit: "fit" }), 1080, 1920, "fit");
    expect(src).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(dst.w).toBeCloseTo(1080, 6);
    expect(dst.h).toBeCloseTo(607.5, 6);
    expect(dst.y).toBeCloseTo((1920 - 607.5) / 2, 6);
  });

  it("respects the crop", () => {
    const { src } = placement(1000, 1000, look({ crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } }), 500, 500, "fill");
    expect(src).toEqual({ x: 100, y: 200, w: 500, h: 500 });
  });
});

describe("drawFrame", () => {
  const calls: number[][] = [];
  const ctx = {
    filter: "none", fillStyle: "",
    save() {}, restore() {}, fillRect() {},
  } as unknown as CanvasRenderingContext2D;
  const draw = (_c: unknown, ...a: number[]) => { calls.push(a); };

  it("draws once for fill, twice for blur (background + picture)", () => {
    calls.length = 0;
    drawFrame(ctx, draw, 1920, 1080, look({ aspect: "9:16" }), 1080, 1920);
    expect(calls).toHaveLength(1);
    calls.length = 0;
    drawFrame(ctx, draw, 1920, 1080, look({ aspect: "9:16", fit: "blur" }), 1080, 1920);
    expect(calls).toHaveLength(2);
    // The background overscans the frame so the blur has no soft edge.
    expect(calls[0][4]).toBeLessThan(0);
  });
});

describe("adjustments and validation", () => {
  it("maps adjustments to a canvas filter", () => {
    expect(adjustFilter(defaultLook())).toBe("none");
    expect(adjustFilter(look({ brightness: 20, contrast: -50, saturation: -100 }))).toBe("brightness(1.200) contrast(0.500) saturate(0.000)");
  });

  it("identity means untouched", () => {
    expect(isIdentityLook(defaultLook())).toBe(true);
    expect(isIdentityLook(look({ aspect: "1:1" }))).toBe(false);
    expect(isIdentityLook(look({ saturation: -1 }))).toBe(false);
    // Fit mode alone doesn't change an original-shape frame.
    expect(isIdentityLook(look({ fit: "blur" }))).toBe(true);
  });

  it("sanitizes untrusted input and keeps the crop inside the frame", () => {
    for (const bad of [null, 3, "x", [], { aspect: "21:9", fit: "zoom", brightness: "lots" }]) {
      const l = sanitizeLook(bad);
      expect(l.aspect).toBe("source");
      expect(l.brightness).toBe(0);
    }
    const l = sanitizeLook({ crop: { x: 0.95, y: -1, w: 0.01, h: 2 }, brightness: 500, background: "javascript:" });
    expect(l.crop.w).toBe(0.1);
    expect(l.crop.x).toBeCloseTo(0.9, 6);
    expect(l.crop.y).toBe(0);
    expect(l.crop.h).toBe(1);
    expect(l.brightness).toBe(100);
    expect(l.background).toBe("#000000");
    expect(sanitizeLook(JSON.parse(JSON.stringify(look({ aspect: "4:5", fit: "blur" }))))).toEqual(look({ aspect: "4:5", fit: "blur" }));
  });
});
