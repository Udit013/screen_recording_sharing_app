// Speech/silence detection over raw PCM.
//
// Pure functions over a Float32Array, so the exact same code runs in the
// browser (on decoded audio) and in tests (on synthetic or recorded signals).
//
// Approach: frame the signal into short windows, measure loudness (RMS, in
// dBFS) per window, then derive the threshold from the recording itself
// instead of a fixed number. A fixed -40 dB threshold works on a studio mic
// and fails on a laptop mic with fan noise; an adaptive one doesn't care.

import type { Range } from "./edl";

export interface SilenceOptions {
  /** Analysis window length. 20 ms resolves syllable gaps without jitter. */
  frameMs?: number;
  /** Shortest quiet stretch reported as a pause, in seconds. */
  minSilence?: number;
  /**
   * Where the threshold sits between the noise floor and typical speech
   * level, 0..1. Lower = only near-silence counts as a pause.
   */
  thresholdRatio?: number;
  /** Loud blips shorter than this inside a pause (clicks, keys) are ignored. */
  maxBlip?: number;
}

const DEFAULTS: Required<SilenceOptions> = {
  frameMs: 20,
  minSilence: 0.6,
  thresholdRatio: 0.3,
  maxBlip: 0.08,
};

/** Floor for digital silence, so log(0) can't produce -Infinity. */
const DB_FLOOR = -100;

/** Per-frame loudness in dBFS. O(n). */
export function loudnessEnvelope(
  samples: Float32Array,
  sampleRate: number,
  frameMs = DEFAULTS.frameMs
): Float32Array {
  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frames = Math.floor(samples.length / frameLen);
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * frameLen;
    for (let i = 0; i < frameLen; i++) {
      const v = samples[base + i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / frameLen);
    env[f] = rms > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(rms)) : DB_FLOOR;
  }
  return env;
}

/** Value at percentile p (0..1) of a copy of `values`. O(n log n). */
export function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) return DB_FLOOR;
  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

export interface SilenceAnalysis {
  silences: Range[];
  /** Estimated background level, dBFS. */
  noiseFloorDb: number;
  /** Estimated typical speech level, dBFS. */
  speechLevelDb: number;
  /** The adaptive threshold actually used. */
  thresholdDb: number;
}

/**
 * Finds pauses. The noise floor is the 10th-percentile frame loudness and the
 * speech level the 90th; the threshold sits `thresholdRatio` of the way
 * between them. A recording with no meaningful dynamic range (all speech, or
 * all noise) yields no silences rather than nonsense.
 */
export function detectSilences(
  samples: Float32Array,
  sampleRate: number,
  options: SilenceOptions = {}
): SilenceAnalysis {
  const o = { ...DEFAULTS, ...options };
  const env = loudnessEnvelope(samples, sampleRate, o.frameMs);
  const frameSec = o.frameMs / 1000;

  const noiseFloorDb = percentile(env, 0.1);
  const speechLevelDb = percentile(env, 0.9);
  const thresholdDb = noiseFloorDb + o.thresholdRatio * (speechLevelDb - noiseFloorDb);

  // Under ~10 dB between floor and speech there's no reliable separation.
  if (speechLevelDb - noiseFloorDb < 10) {
    return { silences: [], noiseFloorDb, speechLevelDb, thresholdDb };
  }

  const quiet = new Uint8Array(env.length);
  for (let i = 0; i < env.length; i++) quiet[i] = env[i] < thresholdDb ? 1 : 0;

  // Absorb short loud blips that sit between quiet runs (a key click or a
  // breath shouldn't split one pause into two short ones).
  const maxBlipFrames = Math.round(o.maxBlip / frameSec);
  let i = 0;
  while (i < quiet.length) {
    if (quiet[i]) { i++; continue; }
    let j = i;
    while (j < quiet.length && !quiet[j]) j++;
    const bounded = i > 0 && j < quiet.length;
    if (bounded && j - i <= maxBlipFrames) quiet.fill(1, i, j);
    i = j;
  }

  const silences: Range[] = [];
  const minFrames = Math.ceil(o.minSilence / frameSec);
  i = 0;
  while (i < quiet.length) {
    if (!quiet[i]) { i++; continue; }
    let j = i;
    while (j < quiet.length && quiet[j]) j++;
    if (j - i >= minFrames) {
      silences.push({ start: i * frameSec, end: j * frameSec });
    }
    i = j;
  }

  return { silences, noiseFloorDb, speechLevelDb, thresholdDb };
}

/**
 * Min/max peak pairs for drawing a waveform with `buckets` columns.
 * Returns interleaved [min0, max0, min1, max1, ...]. O(n).
 */
export function computePeaks(samples: Float32Array, buckets: number): Float32Array {
  const out = new Float32Array(buckets * 2);
  if (samples.length === 0 || buckets <= 0) return out;
  const per = samples.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * per);
    const to = Math.max(from + 1, Math.floor((b + 1) * per));
    let min = 0, max = 0;
    for (let k = from; k < to && k < samples.length; k++) {
      const v = samples[k];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    out[b * 2] = min;
    out[b * 2 + 1] = max;
  }
  return out;
}

/**
 * Splits long audio into Whisper-sized windows (≤ maxWindow seconds), cutting
 * at the middle of a detected pause whenever one exists in the back half of
 * the window. Cutting at a pause means no word is ever split across two
 * Whisper calls, and real per-window progress can be reported.
 */
export function planTranscriptionWindows(
  duration: number,
  silences: Range[],
  maxWindow = 28
): Range[] {
  const windows: Range[] = [];
  let start = 0;
  while (duration - start > maxWindow) {
    const limit = start + maxWindow;
    const earliest = start + maxWindow / 2;
    // Latest pause whose midpoint lands in the back half of this window.
    let cut = limit;
    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      if (mid > earliest && mid <= limit) cut = mid;
    }
    windows.push({ start, end: cut });
    start = cut;
  }
  if (duration - start > 0.05) windows.push({ start, end: duration });
  return windows;
}
