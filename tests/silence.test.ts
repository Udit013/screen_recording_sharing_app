import { describe, it, expect } from "vitest";
import {
  detectSilences,
  loudnessEnvelope,
  computePeaks,
  planTranscriptionWindows,
} from "@/lib/media/silence";

const SR = 16000;

/** Deterministic PRNG so noise is identical on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff) * 2 - 1;
}

/**
 * Builds a signal from [seconds, kind] parts on top of a constant noise floor.
 * "speech" is an amplitude-modulated tone (roughly syllable-rate), so the
 * detector sees realistic dips inside speech rather than a flat sine.
 */
function signal(parts: Array<[number, "speech" | "quiet"]>, noise = 0.003, seed = 7) {
  const total = parts.reduce((s, [d]) => s + d, 0);
  const out = new Float32Array(Math.round(total * SR));
  const rand = rng(seed);
  let i = 0;
  for (const [dur, kind] of parts) {
    const n = Math.round(dur * SR);
    for (let k = 0; k < n; k++, i++) {
      const t = i / SR;
      const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
      const tone = kind === "speech" ? 0.3 * env * Math.sin(2 * Math.PI * 220 * t) : 0;
      out[i] = tone + noise * rand();
    }
  }
  return out;
}

describe("detectSilences", () => {
  it("finds pauses at the right positions on a noisy recording", () => {
    const audio = signal([[2, "speech"], [1.5, "quiet"], [2, "speech"], [2, "quiet"], [1, "speech"]]);
    const { silences } = detectSilences(audio, SR);
    expect(silences).toHaveLength(2);
    expect(silences[0].start).toBeCloseTo(2, 1);
    expect(silences[0].end).toBeCloseTo(3.5, 1);
    expect(silences[1].start).toBeCloseTo(5.5, 1);
    expect(silences[1].end).toBeCloseTo(7.5, 1);
  });

  it("adapts its threshold to the recording's own noise floor", () => {
    // Same structure, background 10x louder (a fan, a laptop mic). A fixed
    // -40 dB threshold would call the whole file speech; adaptive still works.
    const audio = signal([[2, "speech"], [1.5, "quiet"], [2, "speech"]], 0.03);
    const a = detectSilences(audio, SR);
    expect(a.noiseFloorDb).toBeGreaterThan(-40);
    expect(a.silences).toHaveLength(1);
    // A louder floor raises the threshold, so the last syllable's trough can
    // read as quiet: boundaries hold to within ±100 ms (5 analysis frames).
    expect(Math.abs(a.silences[0].start - 2)).toBeLessThan(0.1);
    expect(Math.abs(a.silences[0].end - 3.5)).toBeLessThan(0.1);
  });

  it("ignores pauses shorter than minSilence", () => {
    const audio = signal([[1, "speech"], [0.3, "quiet"], [1, "speech"], [1, "quiet"], [1, "speech"]]);
    expect(detectSilences(audio, SR, { minSilence: 0.6 }).silences).toHaveLength(1);
    expect(detectSilences(audio, SR, { minSilence: 0.2 }).silences).toHaveLength(2);
  });

  it("does not split a pause on a short click", () => {
    const audio = signal([[1, "speech"], [2, "quiet"], [1, "speech"]]);
    // 40 ms click in the middle of the pause.
    const at = Math.round(2 * SR);
    for (let k = 0; k < 0.04 * SR; k++) audio[at + k] = 0.4 * Math.sin(k);
    const { silences } = detectSilences(audio, SR);
    expect(silences).toHaveLength(1);
    expect(silences[0].end - silences[0].start).toBeGreaterThan(1.8);
  });

  it("reports nothing when there is no usable dynamic range", () => {
    expect(detectSilences(signal([[3, "speech"]]), SR).silences).toEqual([]);
    expect(detectSilences(new Float32Array(SR * 2), SR).silences).toEqual([]);
  });
});

describe("loudnessEnvelope", () => {
  it("has one frame per window and a finite floor on digital silence", () => {
    const env = loudnessEnvelope(new Float32Array(SR), SR, 20);
    expect(env.length).toBe(50);
    expect(Math.min(...env)).toBe(-100);
  });
});

describe("computePeaks", () => {
  it("returns interleaved min/max per bucket", () => {
    const p = computePeaks(Float32Array.from([0.1, -0.5, 0.9, -0.2]), 2);
    expect(Array.from(p).map((v) => Math.round(v * 10) / 10)).toEqual([-0.5, 0.1, -0.2, 0.9]);
  });
});

describe("planTranscriptionWindows", () => {
  it("splits at the middle of a pause rather than mid-word", () => {
    const w = planTranscriptionWindows(50, [{ start: 20, end: 22 }]);
    expect(w[0]).toEqual({ start: 0, end: 21 });
    // Windows are contiguous, cover everything, and never exceed the cap.
    expect(w[w.length - 1].end).toBe(50);
    w.forEach((r, i) => {
      expect(r.end - r.start).toBeLessThanOrEqual(28);
      if (i > 0) expect(r.start).toBe(w[i - 1].end);
    });
  });

  it("falls back to a hard split when no pause is available", () => {
    const w = planTranscriptionWindows(60, []);
    expect(w.map((r) => r.end)).toEqual([28, 56, 60]);
    w.forEach((r) => expect(r.end - r.start).toBeLessThanOrEqual(28));
  });

  it("returns one window for short audio", () => {
    expect(planTranscriptionWindows(12, [])).toEqual([{ start: 0, end: 12 }]);
  });
});
