import { describe, expect, it } from "vitest";
import { AUDIO_FORMATS, estimateAudioBytes, formatBytes, maxKbps } from "@/lib/media/audioFormats";
import { makeResampler, encodeRate } from "@/lib/media/audioEncoder";
import { ANALYSIS_RATE, coverSize, estimateVideoBytes, spectrumAt, toAnalysis, videoKbps } from "@/lib/studio/visualizer";

describe("audio formats", () => {
  it("estimates sizes: exact for WAV, bitrate × time for lossy", () => {
    expect(estimateAudioBytes("wav", 0, 10, 48000, 2)).toBe(44 + 10 * 48000 * 4);
    expect(estimateAudioBytes("mp3", 192, 60)).toBe(Math.round(24000 * 60 * 1.01));
    // Opus is capped at 256 kbps.
    expect(estimateAudioBytes("opus", 320, 10)).toBe(estimateAudioBytes("opus", 256, 10));
    expect(maxKbps("mp3")).toBe(320);
  });

  it("has a codec, extension and MIME type for every format", () => {
    expect(AUDIO_FORMATS.mp3).toMatchObject({ codec: "mp3", ext: "mp3", mime: "audio/mpeg" });
    expect(AUDIO_FORMATS.m4a).toMatchObject({ codec: "aac", ext: "m4a" });
    expect(AUDIO_FORMATS.opus).toMatchObject({ codec: "opus", ext: "ogg" });
    expect(AUDIO_FORMATS.wav.codec).toBeNull();
    expect(formatBytes(1536)).toBe("2 KB");
    expect(formatBytes(5 * 1048576)).toBe("5.0 MB");
  });

  it("encodes Opus at 48 kHz and everything else at the source rate", () => {
    expect(encodeRate("opus", 44100)).toBe(48000);
    expect(encodeRate("mp3", 44100)).toBe(44100);
  });
});

describe("streaming resampler", () => {
  it("keeps the frequency and length when converting 44.1 → 48 kHz across chunks", () => {
    const from = 44100, to = 48000, f = 1000, secs = 1;
    const src = Float32Array.from({ length: from * secs }, (_, i) => Math.sin((2 * Math.PI * f * i) / from));
    const rs = makeResampler(from, to);
    const out: number[] = [];
    for (let i = 0; i < src.length; i += 1000) {
      const [l] = rs(src.subarray(i, i + 1000), src.subarray(i, i + 1000));
      out.push(...l);
    }
    expect(Math.abs(out.length - to * secs)).toBeLessThan(3);
    // Count zero crossings: 1 kHz → ~2000 per second either way.
    let zc = 0;
    for (let i = 1; i < out.length; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) zc++;
    expect(Math.abs(zc - 2000)).toBeLessThan(4);
    // Continuity at chunk joins: no sample jumps more than a 1 kHz sine can.
    let maxStep = 0;
    for (let i = 1; i < out.length; i++) maxStep = Math.max(maxStep, Math.abs(out[i] - out[i - 1]));
    expect(maxStep).toBeLessThan((2 * Math.PI * f) / to + 0.01);
  });
});

describe("audio → video", () => {
  it("sizes frames by aspect, bounding the short side", () => {
    expect(coverSize({ aspect: "9:16", shortSide: 720 })).toEqual({ width: 720, height: 1280 });
    expect(coverSize({ aspect: "16:9", shortSide: 1080 })).toEqual({ width: 1920, height: 1080 });
    expect(coverSize({ aspect: "1:1", shortSide: 480 })).toEqual({ width: 480, height: 480 });
    expect(coverSize({ aspect: "4:5", shortSide: 1080 })).toEqual({ width: 1080, height: 1350 });
  });

  it("scales bitrate with pixel count and estimates file size", () => {
    expect(videoKbps("medium", 1280, 720)).toBe(2500);
    expect(videoKbps("medium", 1920, 1080)).toBe(5625);
    expect(videoKbps("low", 480, 480)).toBe(Math.round(1200 * 0.35)); // floor for tiny frames
    expect(estimateVideoBytes(2500, 192, 60)).toBe(Math.round(((2692 * 1000) / 8) * 60 * 1.02));
  });

  it("finds a tone in the right spectrum band, and silence gives nothing", () => {
    const tone = (f: number) => Float32Array.from({ length: ANALYSIS_RATE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * f * i) / ANALYSIS_RATE));
    const low = spectrumAt(tone(100), 0.5), high = spectrumAt(tone(5000), 0.5);
    const argmax = (x: Float32Array) => x.indexOf(Math.max(...x));
    expect(argmax(low)).toBeLessThan(10);
    expect(argmax(high)).toBeGreaterThan(38);
    expect(Math.max(...low)).toBeGreaterThan(0.8);
    expect(Math.max(...spectrumAt(new Float32Array(ANALYSIS_RATE), 0.5))).toBe(0);
    expect(Math.max(...spectrumAt(tone(100), 5))).toBe(0); // past the end
  });

  it("mixes channels down and resamples for analysis", () => {
    const l = new Float32Array(48000).fill(1), r = new Float32Array(48000).fill(0);
    const a = toAnalysis([l, r], 48000);
    expect(a.length).toBe(ANALYSIS_RATE);
    expect(a[100]).toBeCloseTo(0.5, 6);
  });
});

describe("gapless MP3 start", async () => {
  const { mp3StartTrim, trimStart } = await import("@/lib/media/gapless");

  /** An MPEG frame header + Info tag with all four fields + LAME extension declaring `delay`. */
  function infoFrame(delay: number, id3 = false) {
    const b = new Uint8Array(600);
    let o = 0;
    if (id3) { b.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 20], 0); o = 30; }
    b.set([0xff, 0xfb, 0x90, 0x64], o);
    const x = o + 36;
    b.set([..."Info"].map((c) => c.charCodeAt(0)), x);
    b.set([0, 0, 0, 15], x + 4);
    const lame = x + 8 + 4 + 4 + 100 + 4;
    b.set([..."LAME3.100"].map((c) => c.charCodeAt(0)), lame);
    b[lame + 21] = delay >> 4;
    b[lame + 22] = ((delay & 0xf) << 4) | 0x6;
    b[lame + 23] = 0x30;
    return b;
  }

  it("reads the encoder delay and adds the decoder delay", () => {
    expect(mp3StartTrim(infoFrame(576))).toBe(576 + 529);
    expect(mp3StartTrim(infoFrame(1105, true))).toBe(1105 + 529); // after an ID3v2 tag
  });

  it("falls back to the decoder delay, and rejects non-MP3 data", () => {
    const plain = new Uint8Array(200); plain.set([0xff, 0xfb, 0x90, 0x64]);
    expect(mp3StartTrim(plain)).toBe(529);
    expect(mp3StartTrim(new TextEncoder().encode("RIFF....WAVEfmt "))).toBeNull();
  });

  it("drops leading frames and negative-timestamp priming, keeping timestamps contiguous", async () => {
    async function* src() {
      yield { left: Float32Array.from([1, 2, 3, 4]), right: new Float32Array(4), frames: 4, timestamp: -2 / 1000 };
      yield { left: Float32Array.from([5, 6, 7]), right: new Float32Array(3), frames: 3, timestamp: 2 / 1000 };
    }
    const out: number[] = [], ts: number[] = [];
    for await (const c of trimStart(src(), 1000, 1)) { out.push(...c.left); ts.push(c.timestamp); }
    expect(out).toEqual([4, 5, 6, 7]); // 2 priming frames dropped, then 1 more skipped
    expect(ts).toEqual([0, 0.001]);
  });
});
