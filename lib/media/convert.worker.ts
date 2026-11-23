/// <reference lib="webworker" />
// The Convert tool's worker. Everything happens on this device; files never
// leave the browser.
//   - toAudio: any local video/audio file → WAV, MP3, M4A (AAC) or Opus.
//   - toVideo: an audio file → MP4 (H.264 + AAC) with a solid colour or
//     image background, an optional animated visualizer and a title, drawn by
//     the same renderer as the page's live preview (lib/studio/visualizer.ts).
// Cancelling terminates the worker.

import {
  ALL_FORMATS, AudioSample, AudioSampleSink, AudioSampleSource, BlobSource, BufferTarget, Input, Mp4OutputFormat, Output,
  VideoSample, VideoSampleSource, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec, type InputAudioTrack,
} from "mediabunny";
import { encodeAudioFile, measureAacDelay } from "./audioEncoder";
import { mp3StartTrim, readHead, trimStart } from "./gapless";
import type { AudioFormatId } from "./audioFormats";
import { coverSize, drawCover, toAnalysis, type CoverOptions } from "@/lib/studio/visualizer";

export type ConvertRequest =
  | { type: "toAudio"; file: Blob; format: AudioFormatId; kbps: number }
  | { type: "toVideo"; audio: Blob; image: Blob | null; options: CoverOptions; videoKbps: number; audioKbps: number; fontOrigin: string };

export type ConvertEvent =
  | { type: "progress"; fraction: number; stage: string }
  | { type: "done"; buffer: ArrayBuffer; mime: string; ms: number; seconds: number; width?: number; height?: number; codecs: string }
  | { type: "error"; message: string };

const post = (e: ConvertEvent, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(e, transfer);

async function audioTrackOf(file: Blob): Promise<{ input: Input; track: InputAudioTrack; skip: number }> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  const track = await input.getPrimaryAudioTrack().catch(() => null);
  if (!track) throw new Error("This file has no audio track (or its format isn't supported).");
  if (!(await track.canDecode())) throw new Error("This browser can't decode this file's audio codec.");
  // MP3: skip the encoder + decoder delay the LAME tag declares (see gapless.ts).
  const skip = track.codec === "mp3" ? mp3StartTrim(await readHead(file)) ?? 0 : 0;
  return { input, track, skip };
}

/** Decoded audio as contiguous stereo chunks, starting at the true beginning. */
function stereoChunks(track: InputAudioTrack, sampleRate: number, skip: number) {
  return trimStart(rawChunks(track), sampleRate, skip);
}

async function* rawChunks(track: InputAudioTrack) {
  const sink = new AudioSampleSink(track);
  for await (const s of sink.samples()) {
    const n = s.numberOfFrames;
    const left = new Float32Array(n), right = new Float32Array(n);
    s.copyTo(left, { planeIndex: 0, format: "f32-planar" });
    if (s.numberOfChannels > 1) s.copyTo(right, { planeIndex: 1, format: "f32-planar" }); else right.set(left);
    const ts = s.timestamp;
    s.close();
    yield { left, right, frames: n, timestamp: ts };
  }
}

self.onmessage = async (msg: MessageEvent<ConvertRequest>) => {
  const t0 = performance.now();
  try {
    if (msg.data.type === "toAudio") {
      const { file, format, kbps } = msg.data;
      const { input, track, skip } = await audioTrackOf(file);
      const sampleRate = await track.getSampleRate();
      const duration = await track.computeDuration();
      let last = 0;
      const buffer = await encodeAudioFile(format, kbps, sampleRate, async (push) => {
        for await (const c of stereoChunks(track, sampleRate, skip)) {
          await push(c.left, c.right, c.frames, c.timestamp);
          const now = performance.now();
          if (now - last > 150) { last = now; post({ type: "progress", fraction: Math.min(1, (c.timestamp + c.frames / sampleRate) / duration), stage: "Converting" }); }
        }
      });
      input.dispose();
      const mime = { wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", opus: "audio/ogg" }[format];
      post({ type: "done", buffer, mime, ms: performance.now() - t0, seconds: duration, codecs: format.toUpperCase() }, [buffer]);
      return;
    }

    // ── Audio → video ────────────────────────────────────────────────────
    const { audio, image, options, videoKbps, audioKbps, fontOrigin } = msg.data;
    const { input, track, skip } = await audioTrackOf(audio);
    const sampleRate = await track.getSampleRate();
    const duration = await track.computeDuration();
    if (!(duration > 0)) throw new Error("Couldn't read the audio's duration.");

    // Pass 1 (only with a visualizer): decode once for the analysis signal.
    let analysis: Float32Array | null = null;
    if (options.visualizer !== "none") {
      post({ type: "progress", fraction: 0, stage: "Analysing audio" });
      const parts: Float32Array[] = [];
      for await (const c of stereoChunks(track, sampleRate, skip)) {
        const mono = new Float32Array(c.frames);
        for (let i = 0; i < c.frames; i++) mono[i] = (c.left[i] + c.right[i]) / 2;
        parts.push(toAnalysis([mono], sampleRate));
      }
      const total = parts.reduce((s, p) => s + p.length, 0);
      analysis = new Float32Array(total);
      let o = 0;
      for (const p of parts) { analysis.set(p, o); o += p.length; }
    }

    const { width, height } = coverSize(options);
    const bitmap = image ? await createImageBitmap(image) : null;
    if (options.title && typeof FontFace !== "undefined") {
      // Same title fonts as the preview (Latin + Devanagari), best effort.
      const fonts = (self as unknown as { fonts: { add(f: FontFace): void } }).fonts;
      for (const [family, file] of [["SnapCast Inter", "inter-latin-800-normal.woff2"], ["SnapCast Devanagari", "noto-sans-devanagari-devanagari-800-normal.woff2"]]) {
        await new FontFace(family, `url(${fontOrigin}/fonts/captions/${file})`, { weight: "800" }).load().then((f) => fonts.add(f)).catch(() => {});
      }
    }

    const videoCodec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1"], { width, height });
    if (!videoCodec) throw new Error("This browser can't encode video (WebCodecs unavailable).");
    const audioCodec = await getFirstEncodableAudioCodec(["aac", "opus"], { numberOfChannels: 2, sampleRate });
    if (!audioCodec) throw new Error("This browser can't encode AAC or Opus audio.");

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const vSource = new VideoSampleSource({ codec: videoCodec, bitrate: videoKbps * 1000, keyFrameInterval: 2 });
    const aSource = new AudioSampleSource({ codec: audioCodec, bitrate: audioKbps * 1000 });
    output.addVideoTrack(vSource, { frameRate: options.fps });
    output.addAudioTrack(aSource);
    await output.start();

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D canvas in this browser's workers.");
    const frames = Math.ceil(duration * options.fps);
    // Static backgrounds: every frame is identical, so draw once.
    const animated = options.visualizer !== "none";
    if (!animated) drawCover(ctx, width, height, options, bitmap, null, 0);

    let last = 0;
    const encodeVideo = async () => {
      for (let i = 0; i < frames; i++) {
        const t = i / options.fps;
        if (animated) drawCover(ctx, width, height, options, bitmap, analysis, t);
        const frame = new VideoSample(canvas, { timestamp: t, duration: Math.min(1 / options.fps, duration - t) });
        await vSource.add(frame);
        frame.close();
        const now = performance.now();
        if (now - last > 150) { last = now; post({ type: "progress", fraction: (i + 1) / frames, stage: "Rendering video" }); }
      }
      vSource.close();
    };
    const shift = audioCodec === "aac" ? (await measureAacDelay(sampleRate, 2)) / sampleRate : 0;
    const encodeAudio = async () => {
      for await (const c of stereoChunks(track, sampleRate, skip)) {
        const data = new Float32Array(c.frames * 2);
        data.set(c.left, 0);
        data.set(c.right, c.frames);
        const s = new AudioSample({ data, format: "f32-planar", numberOfChannels: 2, sampleRate, timestamp: c.timestamp - shift });
        await aSource.add(s);
        s.close();
      }
      aSource.close();
    };
    await Promise.all([encodeVideo(), encodeAudio()]);
    await output.finalize();
    input.dispose();
    bitmap?.close();
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("Rendering produced no data.");
    post({ type: "done", buffer, mime: "video/mp4", ms: performance.now() - t0, seconds: duration, width, height, codecs: `${videoCodec.toUpperCase()} + ${audioCodec.toUpperCase()}` }, [buffer]);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
