// Draws captions onto a 2D canvas. The SAME code runs in the editor's preview
// overlay and in the export worker, so burned-in captions look exactly like
// the preview: positions, sizes and stroke widths are fractions of the frame,
// and the fonts are the same self-hosted OFL files (public/fonts/captions).

import type { Caption, CaptionFont, CaptionStyle, CaptionWord } from "./captions";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const FAMILY: Record<CaptionFont, string> = {
  inter: "SnapCast Inter",
  montserrat: "SnapCast Montserrat",
  bebas: "SnapCast Bebas Neue",
};
const FILE: Record<CaptionFont, string> = {
  inter: "inter-latin-{w}-normal.woff2",
  montserrat: "montserrat-latin-{w}-normal.woff2",
  bebas: "bebas-neue-latin-400-normal.woff2",
};
const FALLBACK = `"Helvetica Neue", Arial, sans-serif`;

const fontWeight = (style: CaptionStyle) => (style.font === "bebas" ? 400 : style.weight);
const fontKey = (style: CaptionStyle) => `${style.font}:${fontWeight(style)}`;

type FontSetLike = { add(f: FontFace): void; check?(font: string): boolean };
const loaded = new Map<string, Promise<boolean>>();

/**
 * Loads the caption font a style uses. `origin` is needed in a worker, where
 * root-relative URLs don't resolve against the site. Resolves false (and the
 * renderer falls back to a system font) if the file can't be fetched.
 */
export function loadCaptionFont(style: CaptionStyle, origin?: string): Promise<boolean> {
  const key = fontKey(style);
  const existing = loaded.get(key);
  if (existing) return existing;
  const fonts = (globalThis as unknown as { fonts?: FontSetLike }).fonts ??
    (typeof document !== "undefined" ? (document.fonts as unknown as FontSetLike) : undefined);
  if (typeof FontFace === "undefined" || !fonts) return Promise.resolve(false);
  const w = fontWeight(style);
  const base = origin ?? (typeof location !== "undefined" ? location.origin : "");
  const url = `${base}/fonts/captions/${FILE[style.font].replace("{w}", String(w))}`;
  const p = new FontFace(FAMILY[style.font], `url(${url}) format("woff2")`, { weight: String(w) })
    .load()
    .then((face) => { fonts.add(face); return true; })
    .catch(() => { loaded.delete(key); return false; });
  loaded.set(key, p);
  return p;
}

const fontCss = (style: CaptionStyle, px: number) =>
  `${fontWeight(style)} ${px.toFixed(2)}px "${FAMILY[style.font]}", ${FALLBACK}`;

// ── Layout ───────────────────────────────────────────────────────────────

interface PlacedWord { word: CaptionWord; text: string; x: number; width: number }
interface Line { words: PlacedWord[]; width: number }
interface Page { lines: Line[]; start: number; end: number }

/**
 * Splits a caption's words into lines (maxWordsPerLine, and never wider than
 * the safe area) and the lines into pages of maxLines. A caption too long for
 * one page shows its pages in turn, each while its own words are spoken.
 */
export function layoutCaption(ctx: Ctx, caption: Caption, style: CaptionStyle, W: number, H: number): { pages: Page[]; px: number; lineHeight: number } {
  const px = style.size * H;
  ctx.font = fontCss(style, px);
  const maxWidth = W * (1 - 2 * style.safeMargin);
  const space = ctx.measureText(" ").width;
  const words: CaptionWord[] = caption.words && caption.words.length
    ? caption.words
    : [{ text: caption.text, start: caption.start, end: caption.end }];

  const lines: Line[] = [];
  let line: Line = { words: [], width: 0 };
  for (const w of words) {
    const text = style.uppercase ? w.text.toUpperCase() : w.text;
    const width = ctx.measureText(text).width;
    const next = line.words.length ? line.width + space + width : width;
    if (line.words.length && (line.words.length >= style.maxWordsPerLine || next > maxWidth)) {
      lines.push(line);
      line = { words: [], width: 0 };
    }
    line.words.push({ word: w, text, x: line.words.length ? line.width + space : 0, width });
    line.width = line.words.length > 1 ? line.width + space + width : width;
  }
  if (line.words.length) lines.push(line);

  const pages: Page[] = [];
  for (let i = 0; i < lines.length; i += style.maxLines) {
    const ls = lines.slice(i, i + style.maxLines);
    pages.push({ lines: ls, start: ls[0].words[0].word.start, end: ls[ls.length - 1].words[ls[ls.length - 1].words.length - 1].word.end });
  }
  // Pages hand over at the next page's first word, and the first/last page
  // stretch to the caption's own edges.
  for (let i = 0; i < pages.length; i++) {
    pages[i].start = i === 0 ? caption.start : pages[i].start;
    pages[i].end = i === pages.length - 1 ? caption.end : pages[i + 1].start;
  }
  return { pages, px, lineHeight: px * 1.22 };
}

const ease = (x: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

/**
 * Draws `caption` as it looks at time `t` (same timeline as the caption) on a
 * W×H frame. Call with the caption returned by captionAt(); null draws nothing.
 */
export function drawCaption(ctx: Ctx, caption: Caption | null, t: number, style: CaptionStyle, W: number, H: number) {
  if (!caption) return;
  const { pages, px, lineHeight } = layoutCaption(ctx, caption, style, W, H);
  const page = pages.find((p) => t >= p.start && t < p.end) ?? pages[pages.length - 1];
  if (!page) return;

  const anim = style.animation;
  const animS = Math.max(0.001, style.animationMs / 1000);
  const blockH = page.lines.length * lineHeight;
  const blockW = Math.max(...page.lines.map((l) => l.width));
  const margin = style.safeMargin;
  // Clamp the block inside the safe area.
  const cx = Math.min(Math.max(style.x * W, margin * W + blockW / 2), W - margin * W - blockW / 2);
  const top = Math.min(Math.max(style.y * H - blockH / 2, margin * H), H - margin * H - blockH);

  let alpha = 1;
  if (anim === "fade") alpha = Math.min(ease((t - caption.start) / animS), ease((caption.end - t) / animS));
  if (alpha <= 0) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = fontCss(style, px);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  const padX = px * 0.32, padY = px * 0.1;
  page.lines.forEach((line, li) => {
    const lx = style.align === "left" ? cx - blockW / 2 : style.align === "right" ? cx + blockW / 2 - line.width : cx - line.width / 2;
    const ly = top + li * lineHeight + lineHeight / 2;

    if (style.backgroundOpacity > 0) {
      ctx.save();
      ctx.shadowColor = "transparent";
      ctx.fillStyle = rgba(style.background, style.backgroundOpacity);
      roundRect(ctx, lx - padX, ly - lineHeight / 2 - padY + px * 0.04, line.width + padX * 2, lineHeight + padY * 2 - px * 0.08, px * 0.22);
      ctx.fill();
      ctx.restore();
    }

    for (const pw of line.words) {
      const spoken = t >= pw.word.start;
      const active = spoken && t < pw.word.end;
      if ((anim === "pop" || anim === "reveal") && !spoken) continue;

      let scale = 1;
      if (anim === "pop") scale = 0.65 + 0.35 * ease((t - pw.word.start) / animS);
      const highlighted = (anim === "karaoke" || anim === "pop") && active;
      const x = lx + pw.x, y = ly;

      ctx.save();
      if (scale !== 1) {
        ctx.translate(x + pw.width / 2, y);
        ctx.scale(scale, scale);
        ctx.translate(-(x + pw.width / 2), -y);
      }
      if (style.shadow) {
        ctx.shadowColor = "rgba(0,0,0,0.55)";
        ctx.shadowBlur = px * 0.18;
        ctx.shadowOffsetY = px * 0.05;
      }
      if (style.stroke > 0) {
        ctx.strokeStyle = style.strokeColor;
        ctx.lineWidth = style.stroke * px * 2; // half of a centred stroke is hidden under the fill
        ctx.strokeText(pw.text, x, y);
        ctx.shadowColor = "transparent";
      }
      ctx.fillStyle = highlighted ? style.highlight : style.color;
      ctx.fillText(pw.text, x, y);
      ctx.restore();
    }
  });
  ctx.restore();
}
