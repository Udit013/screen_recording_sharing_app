import { describe, expect, it } from "vitest";
import { fft, separate, SEP_RATE, type RunModel } from "@/lib/studio/separate";

const signal = (seconds: number, seed = 1) => {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const n = Math.round(seconds * SEP_RATE);
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SEP_RATE;
    l[i] = 0.3 * Math.sin(2 * Math.PI * 220 * t) + 0.1 * rnd();
    r[i] = 0.3 * Math.sin(2 * Math.PI * 330 * t) + 0.1 * rnd();
  }
  return [l, r] as const;
};

const maxErr = (a: Float32Array, b: Float32Array, from = 0, to = a.length) => {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

describe("FFT", () => {
  it("round-trips", () => {
    const re = Float64Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.37) + (i % 7) * 0.01);
    const im = new Float64Array(4096);
    const orig = Float64Array.from(re);
    fft(re, im);
    fft(re, im, true);
    let m = 0;
    for (let i = 0; i < 4096; i++) m = Math.max(m, Math.abs(re[i] - orig[i]), Math.abs(im[i]));
    expect(m).toBeLessThan(1e-9);
  });
});

describe("separation signal path", () => {
  it("reconstructs the input exactly when everything is vocals", async () => {
    const [l, r] = signal(3);
    const allVocals: RunModel = async (stem, x) => (stem === "vocals" ? x : new Float32Array(x.length));
    const out = await separate(l, r, allVocals);
    // Away from the first/last window (partial overlap), reconstruction is exact.
    expect(maxErr(out.vocals[0], l, 4096, l.length - 4096)).toBeLessThan(1e-5);
    expect(maxErr(out.vocals[1], r, 4096, r.length - 4096)).toBeLessThan(1e-5);
    expect(maxErr(out.accompaniment[0], new Float32Array(l.length), 4096, l.length - 4096)).toBeLessThan(1e-4);
  });

  it("vocals + accompaniment always sum to the input (complementary masks, incl. above 11 kHz)", async () => {
    const [l, r] = signal(2.5, 7);
    // An arbitrary "model": different, frequency-dependent estimates per stem.
    const weird: RunModel = async (stem, x) => {
      const y = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) y[i] = x[i] * (stem === "vocals" ? (i % 1024) / 1024 : 1 - ((i * 7) % 1024) / 1024);
      return y;
    };
    const out = await separate(l, r, weird);
    const sum = Float32Array.from(l, (_, i) => out.vocals[0][i] + out.accompaniment[0][i]);
    expect(maxErr(sum, l, 4096, l.length - 4096)).toBeLessThan(1e-5);
  });

  it("processes long input block by block with the right tensor shape, reporting progress", async () => {
    const [l, r] = signal(13); // > 512 frames → 2 blocks
    const shapes: string[] = [];
    const progress: number[] = [];
    await separate(l, r, async (_s, x, dims) => { shapes.push(dims.join("x")); expect(x.length).toBe(2 * 512 * 1024); return x; }, (f) => progress.push(f));
    expect(shapes).toEqual(["2x1x512x1024", "2x1x512x1024", "2x1x512x1024", "2x1x512x1024"]);
    expect(progress).toEqual([0.5, 1]);
  });

  it("can be cancelled between blocks", async () => {
    const [l, r] = signal(13);
    const ac = new AbortController();
    const p = separate(l, r, async (_s, x) => x, () => ac.abort(), ac.signal);
    await expect(p).rejects.toThrow(/Cancelled/);
  });
});
