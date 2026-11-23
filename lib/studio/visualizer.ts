// Audio → video frames: a background (solid colour or image), an optional
// animated visualizer (spectrum bars or waveform) and an optional title.
// One renderer for the Convert page's live preview and the encoding worker,
// so the MP4 matches the preview. Everything is a pure function of the
// analysis audio and the time, so the same frame always renders the same.

export type VisualizerStyle = "none" | "bars" | "wave";
export type CoverAspect = "9:16" | "16:9" | "1:1" | "4:5";

export interface CoverOptions {
  aspect: CoverAspect;
  /** Short side in pixels (720 → 720×1280 vertical, 1280×720 landscape). */
  shortSide: number;
  fps: number;
  background: string;
  accent: string;
  visualizer: VisualizerStyle;
  title: string;
  /** Dim an image background so the visualizer and title stay readable (0..1). */
  dim: number;
}

export const COVER_ASPECTS: { id: CoverAspect; label: string; hint: string; ratio: number }[] = [
  { id: "9:16", label: "9:16", hint: "Instagram Reels, YouTube Shorts, TikTok", ratio: 9 / 16 },
  { id: "16:9", label: "16:9", hint: "YouTube", ratio: 16 / 9 },
  { id: "1:1", label: "1:1", hint: "Square posts", ratio: 1 },
  { id: "4:5", label: "4:5", hint: "Instagram feed", ratio: 4 / 5 },
];

export const COVER_SIZES = [480, 720, 1080] as const;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export function coverSize(o: Pick<CoverOptions, "aspect" | "shortSide">) {
  const r = COVER_ASPECTS.find((a) => a.id === o.aspect)!.ratio;
  return r >= 1 ? { width: even(o.shortSide * r), height: even(o.shortSide) } : { width: even(o.shortSide), height: even(o.shortSide / r) };
}

/**
 * Video bitrate for a quality level at a size, in kbps. Scales with pixel
 * count from a 720p baseline (low 1.2, medium 2.5, high 5 Mbps). A static
 * image encodes far below this; it's an upper bound for the size estimate.
 */
export function videoKbps(quality: "low" | "medium" | "high", width: number, height: number) {
  const base = { low: 1200, medium: 2500, high: 5000 }[quality];
  return Math.round(base * Math.max(0.35, (width * height) / (1280 * 720)));
}

/** Analysis audio for the visualizer: mono, 24 kHz. */
export const ANALYSIS_RATE = 24000;

export function toAnalysis(channels: Float32Array[], sampleRate: number): Float32Array {
  const n = channels[0]?.length ?? 0;
  const out = new Float32Array(Math.floor((n * ANALYSIS_RATE) / sampleRate));
  const step = sampleRate / ANALYSIS_RATE;
  for (let i = 0; i < out.length; i++) {
    const p = i * step, k = Math.floor(p), f = p - k;
    let s = 0;
    for (const c of channels) s += (c[k] ?? 0) * (1 - f) + (c[k + 1] ?? c[k] ?? 0) * f;
    out[i] = s / channels.length;
  }
  return out;
}

// ── Spectrum ─────────────────────────────────────────────────────────────

const FFT = 2048;
const hann = Float32Array.from({ length: FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1)));

function fftMagnitudes(input: Float32Array): Float32Array {
  const re = Float64Array.from(input), im = new Float64Array(FFT);
  for (let i = 1, j = 0; i < FFT; i++) {
    let bit = FFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= FFT; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < FFT; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar; im[i + k] += ai;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  const mag = new Float32Array(FFT / 2);
  for (let i = 0; i < FFT / 2; i++) mag[i] = Math.hypot(re[i], im[i]) / (FFT / 4);
  return mag;
}

/**
 * Band levels (0..1) at time `t`: a Hann-windowed 2048-point FFT centred on
 * `t`, grouped into `bands` log-spaced bands from 40 Hz to 10 kHz and mapped
 * from −60..0 dBFS. Silence and out-of-range times give zeros.
 */
export function spectrumAt(analysis: Float32Array, t: number, bands = 48): Float32Array {
  const out = new Float32Array(bands);
  const c = Math.round(t * ANALYSIS_RATE);
  if (c < 0 || c >= analysis.length) return out;
  const frame = new Float32Array(FFT);
  for (let i = 0; i < FFT; i++) frame[i] = (analysis[c - FFT / 2 + i] ?? 0) * hann[i];
  const mag = fftMagnitudes(frame);
  const hz = ANALYSIS_RATE / FFT;
  for (let b = 0; b < bands; b++) {
    const lo = 40 * Math.pow(10000 / 40, b / bands), hi = 40 * Math.pow(10000 / 40, (b + 1) / bands);
    let peak = 0;
    for (let k = Math.max(1, Math.floor(lo / hz)); k <= Math.max(Math.floor(lo / hz), Math.ceil(hi / hz)); k++) peak = Math.max(peak, mag[k] ?? 0);
    const db = 20 * Math.log10(peak + 1e-9);
    out[b] = Math.min(1, Math.max(0, (db + 60) / 60));
  }
  return out;
}

// ── Drawing ──────────────────────────────────────────────────────────────

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawCover(ctx: Ctx, W: number, H: number, o: CoverOptions, image: CanvasImageSource & { width: number; height: number } | null, analysis: Float32Array | null, t: number) {
  ctx.save();
  ctx.fillStyle = o.background;
  ctx.fillRect(0, 0, W, H);
  if (image && image.width && image.height) {
    const s = Math.max(W / image.width, H / image.height);
    const w = image.width * s, h = image.height * s;
    ctx.drawImage(image, (W - w) / 2, (H - h) / 2, w, h);
    if (o.dim > 0) { ctx.fillStyle = `rgba(0,0,0,${o.dim})`; ctx.fillRect(0, 0, W, H); }
  }
  const short = Math.min(W, H);
  if (analysis && o.visualizer === "bars") {
    const bands = spectrumAt(analysis, t, 48);
    const areaW = W * 0.86, x0 = (W - areaW) / 2, gap = areaW / bands.length;
    const baseY = H * (o.title ? 0.78 : 0.82), maxH = H * 0.3;
    ctx.fillStyle = o.accent;
    for (let i = 0; i < bands.length; i++) {
      const h = Math.max(short * 0.006, bands[i] * maxH);
      const bw = gap * 0.62;
      const x = x0 + i * gap + (gap - bw) / 2;
      ctx.globalAlpha = 0.55 + 0.45 * bands[i];
      ctx.fillRect(x, baseY - h, bw, h);
    }
    ctx.globalAlpha = 1;
  } else if (analysis && o.visualizer === "wave") {
    const c = Math.round(t * ANALYSIS_RATE), span = Math.round(0.05 * ANALYSIS_RATE);
    const midY = H * (o.title ? 0.7 : 0.6), amp = H * 0.16;
    ctx.strokeStyle = o.accent;
    ctx.lineWidth = Math.max(2, short * 0.006);
    ctx.lineJoin = "round";
    ctx.beginPath();
    const n = 400;
    for (let i = 0; i <= n; i++) {
      const s = analysis[c - span + Math.round((i / n) * 2 * span)] ?? 0;
      const x = W * 0.06 + (i / n) * W * 0.88, y = midY - Math.max(-1, Math.min(1, s * 2.5)) * amp;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  if (o.title) {
    const px = short * 0.075;
    ctx.font = `800 ${px}px "SnapCast Inter", "SnapCast Devanagari", "Helvetica Neue", Arial, sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = px * 0.25;
    const lines = wrap(ctx, o.title, W * 0.84).slice(0, 3);
    const y0 = H * 0.32 - ((lines.length - 1) * px * 1.15) / 2;
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + i * px * 1.15));
  }
  ctx.restore();
}

function wrap(ctx: Ctx, text: string, max: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > max && line) { lines.push(line); line = w; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Estimated MP4 size (upper bound for static backgrounds). */
export const estimateVideoBytes = (videoKbpsValue: number, audioKbpsValue: number, seconds: number) =>
  Math.round((((videoKbpsValue + audioKbpsValue) * 1000) / 8) * seconds * 1.02);
