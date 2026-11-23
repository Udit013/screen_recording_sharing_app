// The audio-effects model: types, the single table of valid ranges, defaults,
// presets and validation. Pure data, shared by the editor UI, the preview
// worklet, the export worker and the server (which must never trust it).
//
// Signal order is fixed (see dsp.ts):
//   input gain → high-pass → noise gate → EQ → low-pass → compressor
//   → delay → reverb → output gain → limiter
// Fades and peak normalization are applied on the edited timeline, outside
// the per-sample chain.

export type EqBandType = "lowshelf" | "peaking" | "highshelf";

export interface EqBand {
  type: EqBandType;
  freq: number;
  gainDb: number;
  q: number;
}

export interface AudioFx {
  version: 1;
  /** Master switch: false plays and exports the original audio untouched. */
  enabled: boolean;
  inputGainDb: number;
  highpass: { enabled: boolean; freq: number };
  lowpass: { enabled: boolean; freq: number };
  gate: { enabled: boolean; thresholdDb: number; rangeDb: number; attackMs: number; releaseMs: number };
  eq: { enabled: boolean; bands: EqBand[] };
  compressor: {
    enabled: boolean;
    thresholdDb: number;
    ratio: number;
    kneeDb: number;
    attackMs: number;
    releaseMs: number;
    makeupDb: number;
  };
  delay: { enabled: boolean; timeMs: number; feedback: number; mix: number; pingPong: boolean };
  reverb: { enabled: boolean; roomSize: number; damping: number; preDelayMs: number; width: number; mix: number };
  outputGainDb: number;
  limiter: { enabled: boolean; ceilingDb: number; releaseMs: number };
  fadeInMs: number;
  fadeOutMs: number;
  /** Two-pass peak normalization, applied when exporting. */
  normalize: { enabled: boolean; targetDb: number };
}

export interface Range {
  min: number;
  max: number;
  step: number;
  unit: string;
}

/**
 * The one table of valid ranges. The UI sliders read it, sanitizeAudioFx
 * clamps to it, and the engine relies on it (e.g. delay feedback stays below
 * 0.85, so the feedback loop can never run away).
 */
export const RANGES = {
  gainDb: { min: -24, max: 24, step: 0.5, unit: "dB" },
  highpass: { min: 20, max: 1000, step: 1, unit: "Hz" },
  lowpass: { min: 1000, max: 20000, step: 10, unit: "Hz" },
  gateThreshold: { min: -90, max: -10, step: 1, unit: "dB" },
  gateRange: { min: -90, max: 0, step: 1, unit: "dB" },
  attackMs: { min: 0.1, max: 200, step: 0.1, unit: "ms" },
  releaseMs: { min: 5, max: 2000, step: 1, unit: "ms" },
  eqFreq: { min: 20, max: 20000, step: 1, unit: "Hz" },
  eqGain: { min: -18, max: 18, step: 0.5, unit: "dB" },
  eqQ: { min: 0.1, max: 18, step: 0.05, unit: "" },
  compThreshold: { min: -60, max: 0, step: 0.5, unit: "dB" },
  compRatio: { min: 1, max: 20, step: 0.1, unit: ":1" },
  compKnee: { min: 0, max: 24, step: 0.5, unit: "dB" },
  makeupDb: { min: 0, max: 24, step: 0.5, unit: "dB" },
  delayMs: { min: 1, max: 1500, step: 1, unit: "ms" },
  feedback: { min: 0, max: 0.85, step: 0.01, unit: "" },
  mix: { min: 0, max: 1, step: 0.01, unit: "" },
  roomSize: { min: 0, max: 1, step: 0.01, unit: "" },
  damping: { min: 0, max: 1, step: 0.01, unit: "" },
  preDelayMs: { min: 0, max: 200, step: 1, unit: "ms" },
  width: { min: 0, max: 1, step: 0.01, unit: "" },
  ceilingDb: { min: -12, max: 0, step: 0.1, unit: "dB" },
  fadeMs: { min: 0, max: 10000, step: 50, unit: "ms" },
  normalizeDb: { min: -12, max: 0, step: 0.1, unit: "dB" },
} satisfies Record<string, Range>;

/** Octave-spaced centre frequencies of the 10-band EQ. */
export const EQ_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const defaultBands = (): EqBand[] =>
  EQ_FREQS.map((freq, i) => ({
    type: i === 0 ? "lowshelf" : i === EQ_FREQS.length - 1 ? "highshelf" : "peaking",
    freq,
    gainDb: 0,
    q: 1.1,
  }));

export const defaultFx = (): AudioFx => ({
  version: 1,
  enabled: true,
  inputGainDb: 0,
  highpass: { enabled: false, freq: 80 },
  lowpass: { enabled: false, freq: 16000 },
  gate: { enabled: false, thresholdDb: -50, rangeDb: -40, attackMs: 2, releaseMs: 120 },
  eq: { enabled: false, bands: defaultBands() },
  compressor: { enabled: false, thresholdDb: -20, ratio: 3, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 3 },
  delay: { enabled: false, timeMs: 320, feedback: 0.35, mix: 0.25, pingPong: false },
  reverb: { enabled: false, roomSize: 0.5, damping: 0.5, preDelayMs: 15, width: 1, mix: 0.2 },
  outputGainDb: 0,
  limiter: { enabled: true, ceilingDb: -1, releaseMs: 80 },
  fadeInMs: 0,
  fadeOutMs: 0,
  normalize: { enabled: false, targetDb: -1 },
});

/**
 * The starting point for a video with no saved settings: everything off, so
 * an untouched video exports as a faithful copy of its audio. (defaultFx()
 * itself has the safety limiter on; it is the base the presets build on.)
 */
export const untouchedFx = (): AudioFx => ({ ...defaultFx(), enabled: false });

/** True when the settings change the sound at all (the export fast path). */
export function isFxActive(fx: AudioFx | null | undefined): boolean {
  if (!fx || !fx.enabled) return false;
  return (
    fx.inputGainDb !== 0 ||
    fx.outputGainDb !== 0 ||
    fx.highpass.enabled ||
    fx.lowpass.enabled ||
    fx.gate.enabled ||
    (fx.eq.enabled && fx.eq.bands.some((b) => b.gainDb !== 0)) ||
    fx.compressor.enabled ||
    fx.delay.enabled ||
    fx.reverb.enabled ||
    fx.limiter.enabled ||
    fx.fadeInMs > 0 ||
    fx.fadeOutMs > 0 ||
    fx.normalize.enabled
  );
}

/**
 * Gain (0..1) at edited-timeline time `t` for the fades. Shared by the live
 * preview and the export so both fade identically.
 */
export function fadeGainAt(t: number, editedDuration: number, fadeInMs: number, fadeOutMs: number): number {
  let g = 1;
  if (fadeInMs > 0) g = Math.min(g, Math.max(0, t / (fadeInMs / 1000)));
  if (fadeOutMs > 0) g = Math.min(g, Math.max(0, (editedDuration - t) / (fadeOutMs / 1000)));
  return g;
}

// ── Validation ───────────────────────────────────────────────────────────

const num = (v: unknown, r: Range, fallback: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(r.max, Math.max(r.min, n));
};
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const BAND_TYPES: EqBandType[] = ["lowshelf", "peaking", "highshelf"];

/**
 * Turns untrusted input (a request body, an old saved project, localStorage)
 * into valid settings: unknown keys are dropped, every number is clamped to
 * RANGES, and anything missing takes its default. Never throws.
 */
export function sanitizeAudioFx(input: unknown): AudioFx {
  const d = defaultFx();
  const i = obj(input);
  const hp = obj(i.highpass), lp = obj(i.lowpass), g = obj(i.gate), eq = obj(i.eq);
  const c = obj(i.compressor), dl = obj(i.delay), rv = obj(i.reverb), lim = obj(i.limiter), nz = obj(i.normalize);
  const rawBands = Array.isArray(eq.bands) ? eq.bands : [];

  return {
    version: 1,
    enabled: bool(i.enabled, d.enabled),
    inputGainDb: num(i.inputGainDb, RANGES.gainDb, 0),
    highpass: { enabled: bool(hp.enabled, false), freq: num(hp.freq, RANGES.highpass, d.highpass.freq) },
    lowpass: { enabled: bool(lp.enabled, false), freq: num(lp.freq, RANGES.lowpass, d.lowpass.freq) },
    gate: {
      enabled: bool(g.enabled, false),
      thresholdDb: num(g.thresholdDb, RANGES.gateThreshold, d.gate.thresholdDb),
      rangeDb: num(g.rangeDb, RANGES.gateRange, d.gate.rangeDb),
      attackMs: num(g.attackMs, RANGES.attackMs, d.gate.attackMs),
      releaseMs: num(g.releaseMs, RANGES.releaseMs, d.gate.releaseMs),
    },
    eq: {
      enabled: bool(eq.enabled, false),
      bands: d.eq.bands.map((def, k) => {
        const b = obj(rawBands[k]);
        return {
          type: BAND_TYPES.includes(b.type as EqBandType) ? (b.type as EqBandType) : def.type,
          freq: num(b.freq, RANGES.eqFreq, def.freq),
          gainDb: num(b.gainDb, RANGES.eqGain, 0),
          q: num(b.q, RANGES.eqQ, def.q),
        };
      }),
    },
    compressor: {
      enabled: bool(c.enabled, false),
      thresholdDb: num(c.thresholdDb, RANGES.compThreshold, d.compressor.thresholdDb),
      ratio: num(c.ratio, RANGES.compRatio, d.compressor.ratio),
      kneeDb: num(c.kneeDb, RANGES.compKnee, d.compressor.kneeDb),
      attackMs: num(c.attackMs, RANGES.attackMs, d.compressor.attackMs),
      releaseMs: num(c.releaseMs, RANGES.releaseMs, d.compressor.releaseMs),
      makeupDb: num(c.makeupDb, RANGES.makeupDb, d.compressor.makeupDb),
    },
    delay: {
      enabled: bool(dl.enabled, false),
      timeMs: num(dl.timeMs, RANGES.delayMs, d.delay.timeMs),
      feedback: num(dl.feedback, RANGES.feedback, d.delay.feedback),
      mix: num(dl.mix, RANGES.mix, d.delay.mix),
      pingPong: bool(dl.pingPong, false),
    },
    reverb: {
      enabled: bool(rv.enabled, false),
      roomSize: num(rv.roomSize, RANGES.roomSize, d.reverb.roomSize),
      damping: num(rv.damping, RANGES.damping, d.reverb.damping),
      preDelayMs: num(rv.preDelayMs, RANGES.preDelayMs, d.reverb.preDelayMs),
      width: num(rv.width, RANGES.width, d.reverb.width),
      mix: num(rv.mix, RANGES.mix, d.reverb.mix),
    },
    outputGainDb: num(i.outputGainDb, RANGES.gainDb, 0),
    limiter: {
      enabled: bool(lim.enabled, d.limiter.enabled),
      ceilingDb: num(lim.ceilingDb, RANGES.ceilingDb, d.limiter.ceilingDb),
      releaseMs: num(lim.releaseMs, RANGES.releaseMs, d.limiter.releaseMs),
    },
    fadeInMs: num(i.fadeInMs, RANGES.fadeMs, 0),
    fadeOutMs: num(i.fadeOutMs, RANGES.fadeMs, 0),
    normalize: { enabled: bool(nz.enabled, false), targetDb: num(nz.targetDb, RANGES.normalizeDb, d.normalize.targetDb) },
  };
}

// ── Presets ──────────────────────────────────────────────────────────────
// Each preset is a real processing chain: a partial set of settings layered
// over the defaults. None of them changes pitch; pitch-based voices need the
// pitch shifter and are not offered until it exists.

type Partial2<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : Partial<T[K]>) : T[K] };
type FxPatch = Partial2<Omit<AudioFx, "version" | "eq">> & { eq?: { enabled?: boolean; gains?: number[] } };

/** Layers a patch over a base; `eq.gains` sets the 10 band gains in order. */
export function applyPatch(base: AudioFx, patch: FxPatch): AudioFx {
  const out: AudioFx = structuredClone(base);
  for (const [key, value] of Object.entries(patch) as [keyof FxPatch, unknown][]) {
    if (key === "eq") {
      const e = value as { enabled?: boolean; gains?: number[] };
      if (e.enabled !== undefined) out.eq.enabled = e.enabled;
      if (e.gains) out.eq.bands = out.eq.bands.map((b, i) => ({ ...b, gainDb: e.gains![i] ?? b.gainDb }));
    } else if (value && typeof value === "object") {
      Object.assign(out[key as "gate"], value);
    } else {
      (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return sanitizeAudioFx(out);
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  patch: FxPatch;
}

//                         32   64  125  250  500   1k   2k   4k   8k  16k
const EQ_VOICE_CLARITY = [  0,   0,  -1,  -2,  -1,   0,   2,   3,   2,   1];
const EQ_PODCAST =       [  0,   1,   1,  -2,  -1,   0,   1,   2,   1,   0];
const EQ_WARM =          [  0,   2,   3,   2,   0,   0,  -1,  -1,  -2,  -2];
const EQ_BRIGHT =        [  0,   0,  -1,  -1,   0,   1,   2,   3,   4,   3];
const EQ_SINGING =       [  0,   0,  -1,  -1,   0,   1,   2,   2,   3,   2];
const EQ_BASS =          [  4,   5,   3,   1,   0,   0,   0,   0,   0,   0];
const EQ_MUSIC =         [  3,   2,   0,  -1,  -1,   0,   1,   2,   3,   3];
const EQ_LOFI =          [ -6,  -3,   0,   2,   3,   2,   0,  -3,  -8, -12];

export const PRESETS: Preset[] = [
  {
    id: "clean-podcast",
    label: "Clean Podcast",
    description: "Removes rumble and room noise between phrases, evens out level.",
    patch: {
      highpass: { enabled: true, freq: 80 },
      gate: { enabled: true, thresholdDb: -48, rangeDb: -20, attackMs: 2, releaseMs: 150 },
      eq: { enabled: true, gains: EQ_PODCAST },
      compressor: { enabled: true, thresholdDb: -22, ratio: 3, kneeDb: 6, attackMs: 8, releaseMs: 160, makeupDb: 5 },
      limiter: { enabled: true, ceilingDb: -1 },
    },
  },
  {
    id: "narration",
    label: "Professional Narration",
    description: "Tighter dynamics and presence for voice-over.",
    patch: {
      highpass: { enabled: true, freq: 90 },
      gate: { enabled: true, thresholdDb: -45, rangeDb: -25, attackMs: 1, releaseMs: 120 },
      eq: { enabled: true, gains: EQ_VOICE_CLARITY },
      compressor: { enabled: true, thresholdDb: -24, ratio: 4, kneeDb: 6, attackMs: 5, releaseMs: 120, makeupDb: 6 },
      reverb: { enabled: true, roomSize: 0.2, damping: 0.7, preDelayMs: 5, width: 0.6, mix: 0.06 },
      limiter: { enabled: true, ceilingDb: -1 },
    },
  },
  {
    id: "studio-vocal",
    label: "Studio Vocal",
    description: "Polished vocal with a short studio space.",
    patch: {
      highpass: { enabled: true, freq: 100 },
      eq: { enabled: true, gains: EQ_SINGING },
      compressor: { enabled: true, thresholdDb: -20, ratio: 3.5, kneeDb: 8, attackMs: 6, releaseMs: 140, makeupDb: 5 },
      reverb: { enabled: true, roomSize: 0.45, damping: 0.55, preDelayMs: 20, width: 1, mix: 0.16 },
      limiter: { enabled: true, ceilingDb: -1 },
    },
  },
  {
    id: "singing",
    label: "Singing Enhancement",
    description: "Air and sparkle, gentle compression, a touch of echo and hall.",
    patch: {
      highpass: { enabled: true, freq: 90 },
      eq: { enabled: true, gains: EQ_SINGING },
      compressor: { enabled: true, thresholdDb: -18, ratio: 3, kneeDb: 10, attackMs: 8, releaseMs: 180, makeupDb: 4 },
      delay: { enabled: true, timeMs: 280, feedback: 0.25, mix: 0.12, pingPong: true },
      reverb: { enabled: true, roomSize: 0.7, damping: 0.4, preDelayMs: 30, width: 1, mix: 0.22 },
      limiter: { enabled: true, ceilingDb: -1 },
    },
  },
  {
    id: "concert",
    label: "Concert Reverb",
    description: "A large hall around the voice.",
    patch: {
      highpass: { enabled: true, freq: 70 },
      reverb: { enabled: true, roomSize: 0.92, damping: 0.3, preDelayMs: 45, width: 1, mix: 0.38 },
      limiter: { enabled: true, ceilingDb: -1 },
    },
  },
  {
    id: "lofi",
    label: "Lo-Fi Voice",
    description: "Band-limited, telephone-like, heavily squashed.",
    patch: {
      highpass: { enabled: true, freq: 300 },
      lowpass: { enabled: true, freq: 3400 },
      eq: { enabled: true, gains: EQ_LOFI },
      compressor: { enabled: true, thresholdDb: -30, ratio: 8, kneeDb: 2, attackMs: 2, releaseMs: 80, makeupDb: 10 },
      limiter: { enabled: true, ceilingDb: -2 },
    },
  },
  {
    id: "robotic",
    label: "Robotic Voice",
    description: "A metallic comb filter: a very short, high-feedback echo.",
    patch: {
      highpass: { enabled: true, freq: 150 },
      delay: { enabled: true, timeMs: 9, feedback: 0.8, mix: 0.6, pingPong: false },
      compressor: { enabled: true, thresholdDb: -24, ratio: 4, kneeDb: 4, attackMs: 4, releaseMs: 100, makeupDb: 4 },
      limiter: { enabled: true, ceilingDb: -1 },
    },
  },
  {
    id: "bright",
    label: "Bright Voice",
    description: "More presence and air.",
    patch: { highpass: { enabled: true, freq: 90 }, eq: { enabled: true, gains: EQ_BRIGHT }, limiter: { enabled: true, ceilingDb: -1 } },
  },
  {
    id: "warm",
    label: "Warm Voice",
    description: "Fuller lows, softer highs.",
    patch: { highpass: { enabled: true, freq: 60 }, eq: { enabled: true, gains: EQ_WARM }, limiter: { enabled: true, ceilingDb: -1 } },
  },
];

/** EQ-only presets, applied to the EQ section alone. */
export const EQ_PRESETS: { id: string; label: string; gains: number[] }[] = [
  { id: "flat", label: "Flat", gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: "vocal-clarity", label: "Vocal Clarity", gains: EQ_VOICE_CLARITY },
  { id: "podcast", label: "Podcast", gains: EQ_PODCAST },
  { id: "warm-voice", label: "Warm Voice", gains: EQ_WARM },
  { id: "bass-boost", label: "Bass Boost", gains: EQ_BASS },
  { id: "music", label: "Music", gains: EQ_MUSIC },
  { id: "singing", label: "Singing", gains: EQ_SINGING },
];

/** Reverb presets. "Plate-like": an algorithmic reverb, not a plate model. */
export const REVERB_PRESETS: { id: string; label: string; reverb: Omit<AudioFx["reverb"], "enabled"> }[] = [
  { id: "room", label: "Room", reverb: { roomSize: 0.35, damping: 0.6, preDelayMs: 5, width: 0.8, mix: 0.15 } },
  { id: "studio", label: "Studio", reverb: { roomSize: 0.25, damping: 0.7, preDelayMs: 8, width: 0.6, mix: 0.1 } },
  { id: "vocal", label: "Vocal", reverb: { roomSize: 0.5, damping: 0.5, preDelayMs: 25, width: 1, mix: 0.18 } },
  { id: "plate", label: "Plate-like", reverb: { roomSize: 0.6, damping: 0.15, preDelayMs: 10, width: 1, mix: 0.22 } },
  { id: "hall", label: "Hall", reverb: { roomSize: 0.9, damping: 0.35, preDelayMs: 40, width: 1, mix: 0.3 } },
];

export const DELAY_PRESETS: { id: string; label: string; delay: Omit<AudioFx["delay"], "enabled"> }[] = [
  { id: "slapback", label: "Slapback", delay: { timeMs: 110, feedback: 0.1, mix: 0.3, pingPong: false } },
  { id: "echo", label: "Echo", delay: { timeMs: 380, feedback: 0.4, mix: 0.3, pingPong: false } },
  { id: "pingpong", label: "Stereo ping-pong", delay: { timeMs: 300, feedback: 0.45, mix: 0.3, pingPong: true } },
];
