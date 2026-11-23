// Video framing: output aspect ratio, how the source fills it (fit, fill,
// blurred background), crop, reposition and colour adjustments. Pure maths
// plus one draw function shared by the editor preview and the export worker,
// so the exported frame is the frame you previewed.

export type AspectId = "source" | "16:9" | "9:16" | "1:1" | "4:5";
export type FitMode = "fit" | "fill" | "blur";

export interface VideoLook {
  version: 1;
  aspect: AspectId;
  fit: FitMode;
  /** Region of the source to use, as fractions of the source frame. */
  crop: { x: number; y: number; w: number; h: number };
  /** In "fill", which part of the (cropped) source stays in frame: 0 = left/top, 1 = right/bottom. */
  focusX: number;
  focusY: number;
  /** Bars colour in "fit". */
  background: string;
  /** Percent, −100…100; 0 is unchanged. */
  brightness: number;
  contrast: number;
  saturation: number;
}

export const ASPECTS: { id: AspectId; label: string; hint: string; ratio: number | null }[] = [
  { id: "source", label: "Original", hint: "Keep the recording's shape", ratio: null },
  { id: "16:9", label: "16:9", hint: "YouTube, presentations", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", hint: "Reels, Shorts, TikTok", ratio: 9 / 16 },
  { id: "1:1", label: "1:1", hint: "Square posts", ratio: 1 },
  { id: "4:5", label: "4:5", hint: "Portrait feed posts", ratio: 4 / 5 },
];

export const defaultLook = (): VideoLook => ({
  version: 1,
  aspect: "source",
  fit: "fill",
  crop: { x: 0, y: 0, w: 1, h: 1 },
  focusX: 0.5,
  focusY: 0.5,
  background: "#000000",
  brightness: 0,
  contrast: 0,
  saturation: 0,
});

const MIN_CROP = 0.1;

/** True when the look changes nothing: the frame is the source, untouched. */
export function isIdentityLook(l: VideoLook): boolean {
  return (
    l.aspect === "source" &&
    l.crop.x === 0 && l.crop.y === 0 && l.crop.w === 1 && l.crop.h === 1 &&
    l.brightness === 0 && l.contrast === 0 && l.saturation === 0
  );
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Output frame size. The crop's own shape when the aspect is "source"; else
 * the preset ratio. `maxShort` bounds the SHORT side (720p means 1280×720
 * landscape or 720×1280 vertical) and the source's short side is never
 * exceeded, so a reframe doesn't invent resolution beyond the recording.
 */
export function outputSize(srcW: number, srcH: number, look: VideoLook, maxShort: number | null): { width: number; height: number } {
  const cw = srcW * look.crop.w, ch = srcH * look.crop.h;
  const ratio = ASPECTS.find((a) => a.id === look.aspect)?.ratio ?? cw / ch;
  const srcShort = Math.min(srcW, srcH);
  let short = Math.min(srcShort, maxShort ?? Infinity);
  if (look.aspect === "source") short = Math.min(short, Math.min(cw, ch));
  return ratio >= 1
    ? { width: even(short * ratio), height: even(short) }
    : { width: even(short), height: even(short / ratio) };
}

export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Where the source goes on a W×H frame: `src` is the region of the source to
 * draw (source pixels), `dst` where it lands (frame pixels).
 */
export function placement(srcW: number, srcH: number, look: VideoLook, W: number, H: number, mode: "fit" | "fill"): { src: Rect; dst: Rect } {
  const c = { x: look.crop.x * srcW, y: look.crop.y * srcH, w: look.crop.w * srcW, h: look.crop.h * srcH };
  if (mode === "fit") {
    const s = Math.min(W / c.w, H / c.h);
    const w = c.w * s, h = c.h * s;
    return { src: c, dst: { x: (W - w) / 2, y: (H - h) / 2, w, h } };
  }
  // fill: cut a W:H window out of the crop, placed by the focus point.
  const s = Math.max(W / c.w, H / c.h);
  const sw = W / s, sh = H / s;
  return {
    src: { x: c.x + (c.w - sw) * look.focusX, y: c.y + (c.h - sh) * look.focusY, w: sw, h: sh },
    dst: { x: 0, y: 0, w: W, h: H },
  };
}

/** CSS filter string for the colour adjustments, or "none". */
export function adjustFilter(look: VideoLook): string {
  const parts: string[] = [];
  if (look.brightness) parts.push(`brightness(${(1 + look.brightness / 100).toFixed(3)})`);
  if (look.contrast) parts.push(`contrast(${(1 + look.contrast / 100).toFixed(3)})`);
  if (look.saturation) parts.push(`saturate(${(1 + look.saturation / 100).toFixed(3)})`);
  return parts.length ? parts.join(" ") : "none";
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
/** Draws source pixels (sx, sy, sw, sh) into the frame at (dx, dy, dw, dh). */
export type DrawSource = (ctx: Ctx, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => void;

/** Canvas filters aren't everywhere (older Safari); without them, adjustments and blur are skipped. */
export const canFilter = (ctx: Ctx) => "filter" in ctx;

/**
 * Draws one framed video frame. `draw` abstracts the source: a <video> in the
 * preview, a decoded VideoSample in the export.
 */
export function drawFrame(ctx: Ctx, draw: DrawSource, srcW: number, srcH: number, look: VideoLook, W: number, H: number) {
  const filters = canFilter(ctx);
  const adjust = filters ? adjustFilter(look) : "none";
  ctx.save();
  if (look.aspect !== "source" && look.fit !== "fill") {
    if (look.fit === "blur") {
      // Background: the same picture filling the frame, blurred and dimmed.
      const bg = placement(srcW, srcH, look, W, H, "fill");
      ctx.filter = filters ? `blur(${Math.round(Math.max(W, H) * 0.03)}px) brightness(0.65) ${adjust === "none" ? "" : adjust}` : "none";
      // Overscan so the blur doesn't fade to transparent at the edges.
      const o = Math.max(W, H) * 0.06;
      draw(ctx, bg.src.x, bg.src.y, bg.src.w, bg.src.h, -o, -o, W + 2 * o, H + 2 * o);
      if (!filters) { ctx.fillStyle = "rgba(0,0,0,0.45)"; ctx.fillRect(0, 0, W, H); }
    } else {
      ctx.fillStyle = look.background;
      ctx.fillRect(0, 0, W, H);
    }
    const p = placement(srcW, srcH, look, W, H, "fit");
    ctx.filter = adjust;
    draw(ctx, p.src.x, p.src.y, p.src.w, p.src.h, p.dst.x, p.dst.y, p.dst.w, p.dst.h);
  } else {
    const p = placement(srcW, srcH, look, W, H, "fill");
    ctx.filter = adjust;
    draw(ctx, p.src.x, p.src.y, p.src.w, p.src.h, p.dst.x, p.dst.y, p.dst.w, p.dst.h);
  }
  ctx.restore();
}

// ── Validation ───────────────────────────────────────────────────────────

const clamp = (v: unknown, min: number, max: number, fb: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Validates an untrusted look (request body, stored project). Never throws. */
export function sanitizeLook(input: unknown): VideoLook {
  const d = defaultLook();
  const l = obj(input);
  const c = obj(l.crop);
  const w = clamp(c.w, MIN_CROP, 1, 1), h = clamp(c.h, MIN_CROP, 1, 1);
  return {
    version: 1,
    aspect: ASPECTS.some((a) => a.id === l.aspect) ? (l.aspect as AspectId) : d.aspect,
    fit: l.fit === "fit" || l.fit === "fill" || l.fit === "blur" ? l.fit : d.fit,
    crop: { x: clamp(c.x, 0, 1 - w, 0), y: clamp(c.y, 0, 1 - h, 0), w, h },
    focusX: clamp(l.focusX, 0, 1, d.focusX),
    focusY: clamp(l.focusY, 0, 1, d.focusY),
    background: typeof l.background === "string" && /^#[0-9a-f]{6}$/i.test(l.background) ? l.background.toLowerCase() : d.background,
    brightness: clamp(l.brightness, -100, 100, 0),
    contrast: clamp(l.contrast, -100, 100, 0),
    saturation: clamp(l.saturation, -100, 100, 0),
  };
}
