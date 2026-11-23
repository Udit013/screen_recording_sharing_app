// Captions: the data model, editing operations, mapping onto the edited
// timeline, and SRT/WebVTT output. Pure functions, unit-tested.
//
// Captions are stored in SOURCE time, like cuts, so editing the cut list
// never has to rewrite them. Everything that displays or exports captions
// first maps them onto the edited timeline with toEditedCaptions(): captions
// after a removed pause move earlier; words inside a cut disappear; a caption
// whose words are all cut disappears entirely.

import { isInsideCut, sourceToEdited, type Range } from "@/lib/media/edl";
import type { Word } from "@/lib/media/align";

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface Caption {
  id: string;
  start: number;
  end: number;
  text: string;
  /** Word timings, for karaoke/pop animation. Absent for hand-typed captions. */
  words?: CaptionWord[];
}

export type CaptionAnimation = "none" | "karaoke" | "pop" | "reveal" | "fade";
export type CaptionFont = "inter" | "montserrat" | "bebas";
export type CaptionAlign = "left" | "center" | "right";

export interface CaptionStyle {
  template: string;
  font: CaptionFont;
  /** Text height as a fraction of the frame height (resolution-independent). */
  size: number;
  weight: 400 | 600 | 700 | 800 | 900;
  uppercase: boolean;
  color: string;
  highlight: string;
  background: string;
  backgroundOpacity: number;
  strokeColor: string;
  /** Outline width as a fraction of the font size. */
  stroke: number;
  shadow: boolean;
  /** Centre of the caption block, as fractions of the frame (0..1). */
  x: number;
  y: number;
  align: CaptionAlign;
  maxWordsPerLine: number;
  maxLines: number;
  animation: CaptionAnimation;
  animationMs: number;
  /** Margin kept clear at every edge, as a fraction of the frame. */
  safeMargin: number;
}

export interface CaptionTrack {
  version: 1;
  /** Burn the captions into exported video frames. */
  burnIn: boolean;
  captions: Caption[];
  style: CaptionStyle;
}

export const CAPTION_LIMITS = {
  maxCaptions: 5000,
  maxText: 300,
  maxWords: 60,
  minDuration: 0.1,
};

// ── Templates ────────────────────────────────────────────────────────────

const base: CaptionStyle = {
  template: "classic",
  font: "inter",
  size: 0.055,
  weight: 700,
  uppercase: false,
  color: "#ffffff",
  highlight: "#ffd400",
  background: "#000000",
  backgroundOpacity: 0,
  strokeColor: "#000000",
  stroke: 0.14,
  shadow: true,
  x: 0.5,
  y: 0.86,
  align: "center",
  maxWordsPerLine: 7,
  maxLines: 2,
  animation: "none",
  animationMs: 160,
  safeMargin: 0.05,
};

export const CAPTION_TEMPLATES: { id: string; label: string; description: string; style: CaptionStyle }[] = [
  { id: "classic", label: "Classic", description: "White text, dark outline, bottom centre.", style: { ...base } },
  {
    id: "bold-reels",
    label: "Bold Reels",
    description: "Large, heavy, high-contrast, lower third.",
    style: { ...base, template: "bold-reels", font: "montserrat", size: 0.075, weight: 900, uppercase: true, stroke: 0.18, y: 0.7, maxWordsPerLine: 3, maxLines: 2, animation: "none" },
  },
  {
    id: "karaoke",
    label: "Karaoke",
    description: "The spoken word lights up as it's said.",
    style: { ...base, template: "karaoke", font: "montserrat", size: 0.065, weight: 800, highlight: "#ffd400", y: 0.72, maxWordsPerLine: 4, maxLines: 2, animation: "karaoke" },
  },
  {
    id: "word-pop",
    label: "Word Pop",
    description: "Each word pops in as it's spoken.",
    style: { ...base, template: "word-pop", font: "montserrat", size: 0.08, weight: 900, uppercase: true, stroke: 0.2, y: 0.62, maxWordsPerLine: 3, maxLines: 1, animation: "pop", animationMs: 180 },
  },
  {
    id: "modern",
    label: "Modern Creator",
    description: "Clean white text on a rounded panel, coloured active word.",
    style: { ...base, template: "modern", font: "inter", size: 0.058, weight: 800, highlight: "#ff4393", background: "#111111", backgroundOpacity: 0.72, stroke: 0, shadow: false, y: 0.78, maxWordsPerLine: 5, maxLines: 2, animation: "karaoke" },
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Small, clean subtitles on a subtle band.",
    style: { ...base, template: "minimal", font: "inter", size: 0.038, weight: 600, background: "#000000", backgroundOpacity: 0.45, stroke: 0, shadow: false, y: 0.9, maxWordsPerLine: 10, maxLines: 2, animation: "fade", animationMs: 120 },
  },
];

export const defaultCaptionStyle = (): CaptionStyle => ({ ...CAPTION_TEMPLATES[0].style });

export const emptyCaptionTrack = (): CaptionTrack => ({ version: 1, burnIn: true, captions: [], style: defaultCaptionStyle() });

let idCounter = 0;
export const newCaptionId = () => `c${Date.now().toString(36)}${(idCounter++).toString(36)}`;

// ── Generation ───────────────────────────────────────────────────────────

/**
 * Splits a word-level transcript into caption segments: a new caption after
 * sentence-ending punctuation, after a pause longer than `maxGap`, when the
 * caption reaches `maxWords`, or when it would run longer than `maxSeconds`.
 */
export function captionsFromWords(
  words: Word[],
  { maxWords = 7, maxGap = 0.6, maxSeconds = 4 } = {}
): Caption[] {
  const out: Caption[] = [];
  let group: Word[] = [];
  const flush = () => {
    if (group.length === 0) return;
    out.push({
      id: newCaptionId(),
      start: group[0].start,
      end: Math.max(group[group.length - 1].end, group[0].start + CAPTION_LIMITS.minDuration),
      text: group.map((w) => w.text).join(" "),
      words: group.map((w) => ({ text: w.text, start: w.start, end: w.end })),
    });
    group = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (group.length > 0) {
      const prev = group[group.length - 1];
      if (
        w.start - prev.end > maxGap ||
        group.length >= maxWords ||
        w.end - group[0].start > maxSeconds ||
        /[.!?]["')\]]?$/.test(prev.text)
      ) {
        flush();
      }
    }
    group.push(w);
  }
  flush();
  return out;
}

// ── Editing ──────────────────────────────────────────────────────────────

const sortCaptions = (cs: Caption[]) => [...cs].sort((a, b) => a.start - b.start);

/**
 * Replaces a caption's text. If the words still line up one-to-one, their
 * timings are kept; otherwise new words are spread evenly across the caption
 * so karaoke/pop animations still have timings to follow.
 */
export function setCaptionText(c: Caption, text: string): Caption {
  const clean = sanitizeText(text);
  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { ...c, text: "", words: [] };
  if (c.words && c.words.length === tokens.length) {
    return { ...c, text: clean, words: c.words.map((w, i) => ({ ...w, text: tokens[i] })) };
  }
  return { ...c, text: clean, words: spreadWords(tokens, c.start, c.end) };
}

function spreadWords(tokens: string[], start: number, end: number): CaptionWord[] {
  const span = Math.max(end - start, CAPTION_LIMITS.minDuration);
  const weights = tokens.map((t) => Math.max(1, t.length));
  const total = weights.reduce((s, x) => s + x, 0);
  let t = start;
  return tokens.map((text, i) => {
    const d = (weights[i] / total) * span;
    const w = { text, start: t, end: t + d };
    t += d;
    return w;
  });
}

/** Splits a caption before word index `at` (1..words-1), or at its midpoint. */
export function splitCaption(c: Caption, at?: number): [Caption, Caption] | null {
  const words = c.words && c.words.length > 1 ? c.words : spreadWords(c.text.split(/\s+/).filter(Boolean), c.start, c.end);
  if (words.length < 2) return null;
  const k = at !== undefined && at > 0 && at < words.length ? at : Math.ceil(words.length / 2);
  const a = words.slice(0, k), b = words.slice(k);
  return [
    { id: c.id, start: c.start, end: a[a.length - 1].end, text: a.map((w) => w.text).join(" "), words: a },
    { id: newCaptionId(), start: b[0].start, end: c.end, text: b.map((w) => w.text).join(" "), words: b },
  ];
}

/** Merges a caption with the one after it. */
export function mergeCaptions(a: Caption, b: Caption): Caption {
  const words = [...(a.words ?? spreadWords(a.text.split(/\s+/).filter(Boolean), a.start, a.end)), ...(b.words ?? spreadWords(b.text.split(/\s+/).filter(Boolean), b.start, b.end))];
  return { id: a.id, start: Math.min(a.start, b.start), end: Math.max(a.end, b.end), text: sanitizeText(`${a.text} ${b.text}`), words };
}

/**
 * Moves a caption's start/end, keeping it at least minDuration long and out
 * of its neighbours. Word timings are clamped into the new range.
 */
export function retimeCaption(list: Caption[], id: string, start: number, end: number, duration: number): Caption[] {
  const sorted = sortCaptions(list);
  const i = sorted.findIndex((c) => c.id === id);
  if (i < 0) return list;
  const lo = i > 0 ? sorted[i - 1].end : 0;
  const hi = i < sorted.length - 1 ? sorted[i + 1].start : duration;
  let s = Math.max(lo, Math.min(start, hi - CAPTION_LIMITS.minDuration));
  let e = Math.min(hi, Math.max(end, s + CAPTION_LIMITS.minDuration));
  if (e - s < CAPTION_LIMITS.minDuration) { s = lo; e = Math.min(hi, lo + CAPTION_LIMITS.minDuration); }
  const c = sorted[i];
  const words = c.words?.map((w) => {
    const ws = Math.min(Math.max(w.start, s), e);
    return { ...w, start: ws, end: Math.min(Math.max(w.end, ws), e) };
  });
  sorted[i] = { ...c, start: round(s), end: round(e), words };
  return sorted;
}

/** Inserts a hand-typed caption at `at`, fitting it into the gap there. */
export function addCaption(list: Caption[], at: number, duration: number, text = "New caption"): Caption[] {
  const sorted = sortCaptions(list);
  if (sorted.some((c) => at >= c.start && at < c.end)) return list; // occupied
  const next = sorted.find((c) => c.start > at);
  const end = Math.min(next ? next.start : duration, at + 2);
  if (end - at < CAPTION_LIMITS.minDuration) return list;
  return sortCaptions([...sorted, { id: newCaptionId(), start: round(at), end: round(end), text, words: spreadWords(text.split(/\s+/), at, end) }]);
}

// ── Edited timeline ──────────────────────────────────────────────────────

/**
 * Captions on the edited timeline. Words whose midpoint is inside a cut are
 * dropped; a caption keeps the span of its remaining words; captions with
 * nothing left are removed. Hand-typed captions (no words) are clipped to
 * the kept material and dropped if none of them is visible.
 */
export function toEditedCaptions(captions: Caption[], merged: Range[]): Caption[] {
  const out: Caption[] = [];
  for (const c of sortCaptions(captions)) {
    if (c.words && c.words.length > 0) {
      const kept = c.words.filter((w) => !isInsideCut((w.start + w.end) / 2, merged));
      if (kept.length === 0) continue;
      const words = kept.map((w) => ({ text: w.text, start: sourceToEdited(w.start, merged), end: sourceToEdited(w.end, merged) }));
      out.push({
        id: c.id,
        start: Math.min(sourceToEdited(c.start, merged), words[0].start),
        end: Math.max(words[words.length - 1].end, sourceToEdited(c.end, merged)),
        text: kept.length === c.words.length ? c.text : kept.map((w) => w.text).join(" "),
        words,
      });
    } else {
      const s = sourceToEdited(c.start, merged), e = sourceToEdited(c.end, merged);
      if (e - s < 0.05) continue; // entirely cut
      out.push({ ...c, start: s, end: e });
    }
  }
  // Mapping can make a trimmed caption overlap its neighbour; never show two at once.
  for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) out[i - 1] = { ...out[i - 1], end: out[i].start };
  return out.filter((c) => c.end - c.start > 0.02);
}

/**
 * Captions on the timeline of an export made of `segments` (kept source
 * ranges, in order): the whole edit, or a clip of it. Everything outside the
 * segments counts as cut.
 */
export function captionsForSegments(captions: Caption[], segments: Range[]): Caption[] {
  const gaps: Range[] = [];
  let at = 0;
  for (const s of segments) {
    if (s.start > at) gaps.push({ start: at, end: s.start });
    at = Math.max(at, s.end);
  }
  gaps.push({ start: at, end: Number.MAX_SAFE_INTEGER });
  return toEditedCaptions(captions, gaps);
}

/** The caption showing at edited time `t`, by binary search. */
export function captionAt(edited: Caption[], t: number): Caption | null {
  let lo = 0, hi = edited.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = edited[mid];
    if (t < c.start) hi = mid - 1;
    else if (t >= c.end) lo = mid + 1;
    else return c;
  }
  return null;
}

// ── Subtitle files ───────────────────────────────────────────────────────

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function timestamp(t: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3_600_000), m = Math.floor((ms % 3_600_000) / 60_000), s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

/** SubRip (.srt). Times are on the timeline the captions are given in. */
export function toSrt(captions: Caption[]): string {
  return captions
    .map((c, i) => `${i + 1}\n${timestamp(c.start, ",")} --> ${timestamp(c.end, ",")}\n${c.text.replace(/\n{2,}/g, "\n")}\n`)
    .join("\n");
}

/** WebVTT (.vtt). Cue text is escaped, so caption text can't inject markup. */
export function toVtt(captions: Caption[]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/-->/g, "--&gt;");
  return `WEBVTT\n\n${captions.map((c) => `${timestamp(c.start, ".")} --> ${timestamp(c.end, ".")}\n${esc(c.text)}\n`).join("\n")}`;
}

// ── Validation ───────────────────────────────────────────────────────────

const round = (t: number) => Math.round(t * 1000) / 1000;

/** Strips control characters and collapses whitespace; caps the length. */
export function sanitizeText(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CAPTION_LIMITS.maxText);
}

const HEX = /^#[0-9a-f]{6}$/i;
const FONTS: CaptionFont[] = ["inter", "montserrat", "bebas"];
const ANIMS: CaptionAnimation[] = ["none", "karaoke", "pop", "reveal", "fade"];
const ALIGNS: CaptionAlign[] = ["left", "center", "right"];
const WEIGHTS = [400, 600, 700, 800, 900] as const;

const clampN = (v: unknown, min: number, max: number, fallback: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function sanitizeCaptionStyle(input: unknown): CaptionStyle {
  const d = defaultCaptionStyle();
  const s = obj(input);
  const pick = <T,>(v: unknown, allowed: readonly T[], fb: T) => (allowed.includes(v as T) ? (v as T) : fb);
  const color = (v: unknown, fb: string) => (typeof v === "string" && HEX.test(v) ? v.toLowerCase() : fb);
  return {
    template: typeof s.template === "string" ? s.template.slice(0, 24).replace(/[^a-z0-9-]/gi, "") || d.template : d.template,
    font: pick(s.font, FONTS, d.font),
    size: clampN(s.size, 0.02, 0.16, d.size),
    weight: pick(s.weight, WEIGHTS, d.weight),
    uppercase: typeof s.uppercase === "boolean" ? s.uppercase : d.uppercase,
    color: color(s.color, d.color),
    highlight: color(s.highlight, d.highlight),
    background: color(s.background, d.background),
    backgroundOpacity: clampN(s.backgroundOpacity, 0, 1, d.backgroundOpacity),
    strokeColor: color(s.strokeColor, d.strokeColor),
    stroke: clampN(s.stroke, 0, 0.4, d.stroke),
    shadow: typeof s.shadow === "boolean" ? s.shadow : d.shadow,
    x: clampN(s.x, 0, 1, d.x),
    y: clampN(s.y, 0, 1, d.y),
    align: pick(s.align, ALIGNS, d.align),
    maxWordsPerLine: Math.round(clampN(s.maxWordsPerLine, 1, 20, d.maxWordsPerLine)),
    maxLines: Math.round(clampN(s.maxLines, 1, 4, d.maxLines)),
    animation: pick(s.animation, ANIMS, d.animation),
    animationMs: clampN(s.animationMs, 0, 1000, d.animationMs),
    safeMargin: clampN(s.safeMargin, 0, 0.2, d.safeMargin),
  };
}

/** Validates an untrusted caption track (request body, old saved project). */
export function sanitizeCaptionTrack(input: unknown, maxDuration: number): CaptionTrack {
  const t = obj(input);
  const raw = Array.isArray(t.captions) ? t.captions.slice(0, CAPTION_LIMITS.maxCaptions) : [];
  const limit = Math.max(0, maxDuration);
  const captions: Caption[] = [];
  for (const item of raw) {
    const c = obj(item);
    const start = clampN(c.start, 0, limit, NaN), end = clampN(c.end, 0, limit, NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 0.01) continue;
    const text = typeof c.text === "string" ? sanitizeText(c.text) : "";
    const words = Array.isArray(c.words)
      ? c.words.slice(0, CAPTION_LIMITS.maxWords).flatMap((w) => {
          const o = obj(w);
          const ws = clampN(o.start, 0, limit, NaN), we = clampN(o.end, 0, limit, NaN);
          const wt = typeof o.text === "string" ? sanitizeText(o.text).slice(0, 48) : "";
          return Number.isFinite(ws) && Number.isFinite(we) && wt ? [{ text: wt, start: round(ws), end: round(Math.max(ws, we)) }] : [];
        })
      : undefined;
    captions.push({
      id: typeof c.id === "string" && /^[a-z0-9-]{1,40}$/i.test(c.id) ? c.id : newCaptionId(),
      start: round(start),
      end: round(end),
      text,
      ...(words && words.length ? { words } : {}),
    });
  }
  captions.sort((a, b) => a.start - b.start);
  return { version: 1, burnIn: typeof t.burnIn === "boolean" ? t.burnIn : true, captions, style: sanitizeCaptionStyle(t.style) };
}
