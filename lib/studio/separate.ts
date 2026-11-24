// Vocal / accompaniment separation with Spleeter 2-stems (Deezer, MIT),
// using the ONNX export from the sherpa-onnx project (Apache-2.0).
//
// The models see magnitude spectrograms; everything else is signal
// processing done here, following sherpa-onnx's reference script
// (scripts/spleeter/separate.py):
//   44.1 kHz stereo → STFT (Hann 4096, hop 1024, no centring)
//   → |X| of the first 1024 bins, in blocks of 512 frames
//   → vocals U-Net and accompaniment U-Net → estimated magnitudes V, A
//   → ratio masks  Mv = (V² + ε/2) / (V² + A² + ε),  Ma likewise
//   → mask the full complex STFT → inverse STFT (overlap-add).
// Two deliberate differences from the reference:
//   - Bins above 1024 (≈ 11 kHz) have no model output. The reference zeroes
//     them, deleting cymbals, sibilance and air from BOTH stems; here each
//     frame's mask is extended with its mean over the top 64 modelled bins,
//     so the stems still sum to the original up there.
//   - Blocks of 512 frames are processed one at a time (the networks treat
//     blocks independently anyway), so memory stays bounded by one block
//     instead of growing with the song.
// Pure TypeScript; the model runner is injected, so the same code runs with
// onnxruntime-web in the browser and onnxruntime-node in tests.

export const SEP_RATE = 44100;
const N = 4096, HOP = 1024, BINS = 1024, FULL = N / 2 + 1, BLOCK = 512;
const EPS = 1e-10;

/** Runs one model on a [2, splits, 512, 1024] magnitude tensor, returning the same shape. */
export type RunModel = (stem: "vocals" | "accompaniment", input: Float32Array, dims: number[]) => Promise<Float32Array>;

export interface Stems { vocals: [Float32Array, Float32Array]; accompaniment: [Float32Array, Float32Array] }

const hann = (() => {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); // periodic, as torch.hann_window
  return w;
})();

// In-place radix-2 complex FFT (inverse when `inv`), N = 4096.
const bitrev = (() => {
  const r = new Uint32Array(N);
  for (let i = 0, j = 0; i < N; i++) {
    r[i] = j;
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
  }
  return r;
})();
const twr = new Float64Array(N / 2), twi = new Float64Array(N / 2);
for (let k = 0; k < N / 2; k++) { twr[k] = Math.cos((-2 * Math.PI * k) / N); twi[k] = Math.sin((-2 * Math.PI * k) / N); }

export function fft(re: Float64Array, im: Float64Array, inv = false) {
  for (let i = 0; i < N; i++) {
    const j = bitrev[i];
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const step = N / len, half = len >> 1;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = twr[k * step], wi = inv ? -twi[k * step] : twi[k * step];
        const a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inv) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
}

/**
 * Separates 44.1 kHz stereo into vocals and accompaniment. `onProgress`
 * gets the fraction done after each block; `signal` cancels between blocks.
 */
export async function separate(
  left: Float32Array,
  right: Float32Array,
  run: RunModel,
  onProgress: (fraction: number) => void = () => {},
  signal?: AbortSignal
): Promise<Stems> {
  const len = left.length;
  // Frames over the signal padded by N at the end (as the reference does),
  // so the last samples are fully covered by windows.
  const frames = Math.max(1, Math.floor((len + N - N) / HOP) + 1);
  const outV = [new Float64Array(len + N), new Float64Array(len + N)];
  const outA = [new Float64Array(len + N), new Float64Array(len + N)];
  const wsum = new Float64Array(len + N);
  const src = [left, right];
  const at = (c: number, i: number) => (i < len ? src[c][i] : 0);

  const blocks = Math.ceil(frames / BLOCK);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let b = 0; b < blocks; b++) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const f0 = b * BLOCK, nf = Math.min(BLOCK, frames - f0);
    // Complex STFT of this block, both channels: [c][frame][bin] (re, im).
    const specRe = [new Float32Array(nf * FULL), new Float32Array(nf * FULL)];
    const specIm = [new Float32Array(nf * FULL), new Float32Array(nf * FULL)];
    const mag = new Float32Array(2 * BLOCK * BINS); // zero-padded to 512 frames
    for (let c = 0; c < 2; c++) {
      for (let f = 0; f < nf; f++) {
        const s = (f0 + f) * HOP;
        for (let i = 0; i < N; i++) { re[i] = at(c, s + i) * hann[i]; im[i] = 0; }
        fft(re, im);
        const o = f * FULL;
        for (let k = 0; k < FULL; k++) { specRe[c][o + k] = re[k]; specIm[c][o + k] = im[k]; }
        const m = (c * BLOCK + f) * BINS;
        for (let k = 0; k < BINS; k++) mag[m + k] = Math.hypot(re[k], im[k]);
      }
    }
    const dims = [2, 1, BLOCK, BINS];
    const v = await run("vocals", mag, dims);
    const a = await run("accompaniment", mag, dims);

    for (let c = 0; c < 2; c++) {
      for (let f = 0; f < nf; f++) {
        const m = (c * BLOCK + f) * BINS;
        // Ratio masks for the modelled bins, and the extension value above.
        const mv = new Float64Array(FULL);
        let ext = 0;
        for (let k = 0; k < BINS; k++) {
          const v2 = v[m + k] * v[m + k], a2 = a[m + k] * a[m + k];
          mv[k] = (v2 + EPS / 2) / (v2 + a2 + EPS);
          if (k >= BINS - 64) ext += mv[k];
        }
        ext /= 64;
        for (let k = BINS; k < FULL; k++) mv[k] = ext;
        // Masked spectra → time domain, overlap-add (vocals, then accompaniment).
        const o = f * FULL, s = (f0 + f) * HOP;
        for (const [stem, out] of [[0, outV], [1, outA]] as const) {
          for (let k = 0; k < FULL; k++) {
            const g = stem === 0 ? mv[k] : 1 - mv[k];
            re[k] = specRe[c][o + k] * g; im[k] = specIm[c][o + k] * g;
          }
          for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; } // Hermitian
          fft(re, im, true);
          const dst = out[c];
          for (let i = 0; i < N; i++) dst[s + i] += re[i] * hann[i];
        }
        if (c === 0) for (let i = 0; i < N; i++) wsum[s + i] += hann[i] * hann[i];
      }
    }
    onProgress((b + 1) / blocks);
    await new Promise((r) => setTimeout(r, 0)); // let progress and cancel through
  }

  const finish = (x: Float64Array) => {
    const y = new Float32Array(len);
    for (let i = 0; i < len; i++) y[i] = wsum[i] > 1e-8 ? x[i] / wsum[i] : 0;
    return y;
  };
  return {
    vocals: [finish(outV[0]), finish(outV[1])],
    accompaniment: [finish(outA[0]), finish(outA[1])],
  };
}
