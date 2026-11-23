import { describe, expect, it } from "vitest";
import { createAudioEngine, type AudioEngine } from "@/lib/studio/dsp";
import { applyPatch, defaultFx, fadeGainAt, isFxActive, PRESETS, sanitizeAudioFx, untouchedFx, type AudioFx } from "@/lib/studio/fx";

const SR = 48000;

const sine = (freq: number, seconds: number, amp = 0.5) => {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
};
const impulse = (seconds: number, at = 0) => {
  const out = new Float32Array(Math.round(seconds * SR));
  out[at] = 1;
  return out;
};
const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-12));
const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** Runs a mono signal through the engine as identical L/R, in fixed blocks. */
function run(fx: AudioFx, input: Float32Array, block = 128, engine?: AudioEngine) {
  const e = engine ?? createAudioEngine(SR);
  e.configure(fx);
  const L = Float32Array.from(input), R = Float32Array.from(input);
  for (let i = 0; i < L.length; i += block) {
    const n = Math.min(block, L.length - i);
    e.process(L.subarray(i, i + n), R.subarray(i, i + n), n);
  }
  return { L, R, engine: e };
}

/** Everything off, limiter off: a clean starting point for one effect. */
const bare = (patch: Parameters<typeof applyPatch>[1] = {}) =>
  applyPatch(defaultFx(), { limiter: { enabled: false }, ...patch });

// Steady-state level: skip the first 100 ms of filter/envelope settling.
const settled = (x: Float32Array) => rms(x, Math.round(0.1 * SR));

describe("audio engine", () => {
  it("passes audio through untouched when bypassed", () => {
    const input = sine(440, 0.2);
    const fx = { ...bare({ reverb: { enabled: true }, delay: { enabled: true } }), enabled: false };
    expect(Array.from(run(fx, input).L)).toEqual(Array.from(input));
  });

  it("is transparent with every effect off", () => {
    const input = sine(440, 0.2);
    const { L } = run(bare(), input);
    for (let i = 0; i < L.length; i++) expect(L[i]).toBeCloseTo(input[i], 6);
  });

  it("high-pass removes low frequencies and keeps high ones", () => {
    const fx = bare({ highpass: { enabled: true, freq: 500 } });
    expect(db(settled(run(fx, sine(50, 0.5)).L) / settled(sine(50, 0.5)))).toBeLessThan(-30);
    expect(db(settled(run(fx, sine(5000, 0.5)).L) / settled(sine(5000, 0.5)))).toBeGreaterThan(-0.5);
  });

  it("low-pass removes high frequencies and keeps low ones", () => {
    const fx = bare({ lowpass: { enabled: true, freq: 1000 } });
    expect(db(settled(run(fx, sine(10000, 0.5)).L) / settled(sine(10000, 0.5)))).toBeLessThan(-30);
    expect(db(settled(run(fx, sine(100, 0.5)).L) / settled(sine(100, 0.5)))).toBeGreaterThan(-0.5);
  });

  it("an EQ band boosts its frequency by its gain and leaves distant ones alone", () => {
    const gains = [0, 0, 0, 0, 0, 12, 0, 0, 0, 0]; // +12 dB at 1 kHz
    const fx = bare({ eq: { enabled: true, gains } });
    expect(db(settled(run(fx, sine(1000, 0.5)).L) / settled(sine(1000, 0.5)))).toBeCloseTo(12, 0);
    expect(Math.abs(db(settled(run(fx, sine(40, 0.5)).L) / settled(sine(40, 0.5))))).toBeLessThan(0.5);
    // The response curve the UI draws agrees with what the audio does.
    const e = createAudioEngine(SR);
    e.configure(fx);
    expect(e.eqResponse([1000])[0]).toBeCloseTo(12, 1);
  });

  it("noise gate attenuates quiet passages by its range and passes loud ones", () => {
    const fx = bare({ gate: { enabled: true, thresholdDb: -40, rangeDb: -30, attackMs: 1, releaseMs: 20 } });
    const quiet = sine(300, 0.6, 0.003); // ≈ -50 dBFS, below the threshold
    const loud = sine(300, 0.6, 0.3);
    expect(db(settled(run(fx, quiet).L) / settled(quiet))).toBeCloseTo(-30, 0);
    expect(db(settled(run(fx, loud).L) / settled(loud))).toBeGreaterThan(-0.5);
  });

  it("compressor reduces a loud signal toward threshold + overshoot / ratio", () => {
    const fx = bare({
      compressor: { enabled: true, thresholdDb: -20, ratio: 4, kneeDb: 0, attackMs: 1, releaseMs: 50, makeupDb: 0 },
    });
    const input = sine(200, 1, 1); // 0 dBFS peak
    const out = run(fx, input).L;
    // Peak detector on a sine: output peak ≈ -20 + 20/4 = -15 dBFS.
    expect(db(peak(out.subarray(Math.round(0.5 * SR))))).toBeCloseTo(-15, 0);
  });

  it("limiter never lets a sample exceed the ceiling", () => {
    const fx = applyPatch(defaultFx(), { inputGainDb: 18, limiter: { enabled: true, ceilingDb: -1, releaseMs: 50 } });
    const noise = new Float32Array(SR);
    let seed = 7;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = (seed / 0x7fffffff) * 2 - 1;
    }
    const ceiling = Math.pow(10, -1 / 20);
    const { L, R } = run(fx, noise);
    expect(peak(L)).toBeLessThanOrEqual(ceiling + 1e-6);
    expect(peak(R)).toBeLessThanOrEqual(ceiling + 1e-6);
    // ...and it limits by gain, not by clipping: few samples sit at the clamp.
    const atClamp = L.filter((v) => Math.abs(v) >= ceiling - 1e-6).length;
    expect(atClamp / L.length).toBeLessThan(0.01);
  });

  it("delay repeats an impulse at the delay time, decaying by the feedback", () => {
    const fx = bare({ delay: { enabled: true, timeMs: 100, feedback: 0.5, mix: 0.5, pingPong: false } });
    const { L } = run(fx, impulse(0.5));
    const d = Math.round(0.1 * SR);
    expect(L[d]).toBeCloseTo(0.5, 5); // first echo: mix × 1
    expect(L[2 * d]).toBeCloseTo(0.25, 5); // second: × feedback
    expect(L[d - 1]).toBe(0);
  });

  it("ping-pong delay alternates sides", () => {
    const fx = bare({ delay: { enabled: true, timeMs: 50, feedback: 0.6, mix: 1, pingPong: true } });
    const { L, R } = run(fx, impulse(0.3));
    const d = Math.round(0.05 * SR);
    expect(Math.abs(L[d])).toBeGreaterThan(0.1);
    expect(Math.abs(R[d])).toBeLessThan(1e-6);
    expect(Math.abs(R[2 * d])).toBeGreaterThan(0.1);
  });

  it("delay stays stable at maximum feedback", () => {
    const fx = bare({ delay: { enabled: true, timeMs: 20, feedback: 5, mix: 1 } }); // clamped to 0.85
    expect(fx.delay.feedback).toBe(0.85);
    const { L } = run(fx, impulse(10));
    expect(peak(L.subarray(9 * SR))).toBeLessThan(1e-3);
  });

  it("reverb produces a tail after the input stops, which then dies away", () => {
    const fx = bare({ reverb: { enabled: true, roomSize: 0.9, damping: 0.3, preDelayMs: 0, width: 1, mix: 0.5 } });
    const { L } = run(fx, impulse(12));
    expect(rms(L, Math.round(0.2 * SR), Math.round(0.5 * SR))).toBeGreaterThan(1e-4); // audible tail
    expect(rms(L, 11 * SR)).toBeLessThan(rms(L, Math.round(0.2 * SR), Math.round(0.5 * SR)) / 100); // decays
    expect(Number.isFinite(peak(L))).toBe(true);
  });

  it("reverb pre-delay holds the wet signal back", () => {
    const fx = bare({ reverb: { enabled: true, roomSize: 0.5, damping: 0.5, preDelayMs: 100, width: 1, mix: 1 } });
    const { L } = run(fx, impulse(0.3));
    expect(peak(L.subarray(1, Math.round(0.1 * SR)))).toBe(0);
  });

  it("gives identical output whatever the block size (preview vs export)", () => {
    const fx = PRESETS.find((p) => p.id === "singing")!;
    const settings = applyPatch(defaultFx(), fx.patch);
    const input = sine(220, 1, 0.8);
    const a = run(settings, input, 128).L;
    const b = run(settings, input, 4096).L;
    const c = run(settings, input, 333).L;
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(Array.from(c)).toEqual(Array.from(a));
  });

  it("is deterministic after reset", () => {
    const settings = applyPatch(defaultFx(), PRESETS[0].patch);
    const input = sine(300, 0.5, 0.7);
    const e = createAudioEngine(SR);
    const first = run(settings, input, 128, e).L;
    e.reset();
    const second = run(settings, input, 128, e).L;
    expect(Array.from(second)).toEqual(Array.from(first));
  });

  it("reports the limiter's look-ahead as latency, and none when it is off", () => {
    const e = createAudioEngine(SR);
    e.configure(defaultFx());
    expect(e.latency()).toBe(Math.round(0.005 * SR) + 1);
    e.configure(bare());
    expect(e.latency()).toBe(0);
  });

  it("can be rebuilt from its own source text, as the worklet does", () => {
    // The worklet receives createAudioEngine.toString(); any reference to
    // module scope would be undefined there. This catches that here.
    const rebuilt = new Function(`return (${createAudioEngine.toString()})`)() as typeof createAudioEngine;
    const settings = applyPatch(defaultFx(), PRESETS[3].patch);
    const input = sine(330, 0.3, 0.6);
    const a = run(settings, input, 128, rebuilt(SR)).L;
    const b = run(settings, input, 128).L;
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe("effect settings", () => {
  it("clamps every number into range and drops unknown keys", () => {
    const fx = sanitizeAudioFx({
      inputGainDb: 999,
      delay: { enabled: true, feedback: 2, timeMs: -5, evil: "x" },
      eq: { enabled: true, bands: [{ type: "notch", freq: 1e9, gainDb: -100, q: 0 }] },
      reverb: { mix: "0.4" },
      script: "<img onerror>",
    });
    expect(fx.inputGainDb).toBe(24);
    expect(fx.delay).toEqual({ enabled: true, timeMs: 1, feedback: 0.85, mix: 0.25, pingPong: false });
    expect(fx.eq.bands[0]).toEqual({ type: "lowshelf", freq: 20000, gainDb: -18, q: 0.1 });
    expect(fx.eq.bands).toHaveLength(10);
    expect(fx.reverb.mix).toBe(0.4);
    expect("script" in fx).toBe(false);
  });

  it("turns anything that isn't an object into the defaults", () => {
    for (const bad of [null, undefined, 42, "fx", [1, 2]]) expect(sanitizeAudioFx(bad)).toEqual(defaultFx());
  });

  it("survives a serialization round trip unchanged", () => {
    const fx = applyPatch(defaultFx(), PRESETS[1].patch);
    expect(sanitizeAudioFx(JSON.parse(JSON.stringify(fx)))).toEqual(fx);
  });

  it("every built-in preset is valid and actually changes the sound", () => {
    for (const p of PRESETS) {
      const fx = applyPatch(defaultFx(), p.patch);
      expect(sanitizeAudioFx(fx)).toEqual(fx);
      expect(isFxActive(fx)).toBe(true);
      const input = sine(440, 0.3, 0.5);
      const out = run(fx, input).L;
      let diff = 0;
      for (let i = 0; i < out.length; i++) diff += Math.abs(out[i] - input[i]);
      expect(diff / out.length, p.id).toBeGreaterThan(1e-3);
    }
  });

  it("starts a video with no saved settings as a faithful copy (no processing)", () => {
    // Regression: starting from defaultFx() ran every untouched export through the limiter.
    expect(isFxActive(untouchedFx())).toBe(false);
    const input = sine(440, 0.2, 0.99);
    expect(Array.from(run(untouchedFx(), input).L)).toEqual(Array.from(input));
  });

  it("fades follow the edited timeline", () => {
    expect(fadeGainAt(0, 10, 1000, 0)).toBe(0);
    expect(fadeGainAt(0.5, 10, 1000, 0)).toBeCloseTo(0.5);
    expect(fadeGainAt(5, 10, 1000, 2000)).toBe(1);
    expect(fadeGainAt(9, 10, 0, 2000)).toBeCloseTo(0.5);
    expect(fadeGainAt(10, 10, 0, 2000)).toBe(0);
  });

  it("treats disabled or untouched settings as inactive (export fast path)", () => {
    expect(isFxActive(null)).toBe(false);
    expect(isFxActive({ ...defaultFx(), enabled: false })).toBe(false);
    expect(isFxActive(bare())).toBe(false);
    expect(isFxActive(defaultFx())).toBe(true); // the default limiter is a real effect
  });
});

describe("pitch shift", () => {
  /** Strongest frequency within ±25% of `near` (Goertzel scan, 0.25 Hz steps), over the settled part. */
  const freqOf = (x: Float32Array, near: number) => {
    const from = Math.round(0.2 * SR);
    let best = 0, bestF = 0;
    for (let f = near * 0.75; f <= near * 1.25; f += 0.25) {
      const w = (2 * Math.PI * f) / SR, c = 2 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = from; i < x.length; i++) { const s0 = x[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      const p = s1 * s1 + s2 * s2 - c * s1 * s2;
      if (p > best) { best = p; bestF = f; }
    }
    return bestF;
  };

  for (const [st, expected] of [[12, 440], [-12, 110], [3, 220 * Math.pow(2, 3 / 12)], [-4, 220 * Math.pow(2, -4 / 12)]] as const) {
    it(`shifts 220 Hz by ${st} semitones to ${expected.toFixed(1)} Hz`, () => {
      const out = run(bare({ pitch: { enabled: true, semitones: st } }), sine(220, 2)).L;
      expect(freqOf(out, expected) / expected).toBeCloseTo(1, 2);
    });
  }

  it("keeps the level close to the input", () => {
    const input = sine(220, 2);
    const out = run(bare({ pitch: { enabled: true, semitones: 5 } }), input).L;
    expect(Math.abs(db(settled(out)) - db(settled(input)))).toBeLessThan(3);
    expect(peak(out)).toBeLessThan(0.75);
  });

  it("does nothing at 0 semitones or when off, and reports its latency", () => {
    const input = sine(220, 0.5);
    expect(Array.from(run(bare({ pitch: { enabled: true, semitones: 0 } }), input).L)).toEqual(Array.from(input));
    const e = createAudioEngine(SR);
    e.configure(bare({ pitch: { enabled: true, semitones: 2 } }));
    expect(e.latency()).toBe(Math.round((0.06 * SR + 0.0125 * SR) / 2));
    expect(isFxActive(bare({ pitch: { enabled: true, semitones: 2 } }))).toBe(true);
    expect(isFxActive(bare({ pitch: { enabled: true, semitones: 0 } }))).toBe(false);
  });

  it("loads settings saved before pitch existed as off", () => {
    const old = JSON.parse(JSON.stringify(defaultFx())) as Record<string, unknown>;
    delete old.pitch;
    expect(sanitizeAudioFx(old).pitch).toEqual({ enabled: false, semitones: 0 });
    expect(sanitizeAudioFx({ pitch: { enabled: true, semitones: 99 } }).pitch.semitones).toBe(12);
  });
});
