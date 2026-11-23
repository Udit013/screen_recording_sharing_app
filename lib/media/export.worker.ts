/// <reference lib="webworker" />
// Renders an edit to a real MP4, in the browser, with WebCodecs.
//
// Why here and not on a server: Cloudinary's splice transformation was tested
// for this first and measured unreliable — when chaining trims of one asset,
// every layer after the first ignored its end offset (3 segments rendered as
// 26.4 s instead of 15 s). WebCodecs uses the device's hardware encoder, costs
// nothing to run, and gives exact control over every frame and sample.
//
// Pipeline: demux the source (mediabunny) → decode → keep only samples inside
// kept segments → re-time them onto the edited timeline → encode → mux MP4.
// Video and audio are re-timed by the SAME segment offsets, which is what
// keeps them in sync across every cut.

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  UrlSource,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type InputAudioTrack,
} from "mediabunny";
import type { Range } from "./edl";
import { createAudioEngine } from "@/lib/studio/dsp";
import { defaultFx, fadeGainAt, isFxActive, type AudioFx } from "@/lib/studio/fx";
import { WavWriter } from "@/lib/studio/wav";
import { captionAt, captionsForSegments, sanitizeCaptionStyle, type Caption, type CaptionStyle } from "@/lib/studio/captions";
import { drawCaption, loadCaptionFont } from "@/lib/studio/captionRender";
import {
  EXPORT_PRESETS,
  type ExportEvent,
  type ExportQuality,
  type ExportRequest,
} from "./export-presets";

const QUALITY: Record<ExportQuality, typeof QUALITY_HIGH> = {
  high: QUALITY_HIGH,
  medium: QUALITY_MEDIUM,
  low: QUALITY_LOW,
};

const post = (e: ExportEvent, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(e, transfer);

/** Pre-roll so a sample that starts just before a cut point isn't skipped. */
const PREROLL = 0.25;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * mediabunny retries failed range requests forever by default, which would
 * leave the dialog on "preparing" indefinitely when offline. Back off three
 * times (0.5 s, 1 s, 2 s), then surface the error.
 */
const MAX_RETRIES = 3;
const retryDelay = (attempts: number) => (attempts < MAX_RETRIES ? 0.5 * 2 ** attempts : null);

/**
 * The edited audio: decoded at the source's full sample rate (never the 16 kHz
 * analysis copy), trimmed sample-accurately to each kept segment, and given
 * its timestamp on the edited timeline. The caller owns closing each sample.
 */
async function* editedAudio(track: InputAudioTrack, segments: Range[]) {
  const sink = new AudioSampleSink(track);
  let offset = 0;
  for (const seg of segments) {
    for await (const sample of sink.samples(Math.max(0, seg.start - PREROLL), seg.end)) {
      const ts = sample.timestamp;
      const sr = sample.sampleRate;
      const from = Math.max(0, Math.round((seg.start - ts) * sr));
      const to = Math.min(sample.numberOfFrames, Math.round((seg.end - ts) * sr));
      if (to <= from) { sample.close(); continue; }
      const piece = from === 0 && to === sample.numberOfFrames ? sample : sample.trim(from, to);
      if (piece !== sample) sample.close();
      yield { sample: piece, editedTs: offset + (ts + from / sr - seg.start) };
    }
    offset += seg.end - seg.start;
  }
}

/** Planar stereo copies of a sample; mono is duplicated, extra channels dropped. */
function stereoPlanes(sample: AudioSample): [Float32Array, Float32Array] {
  const frames = sample.numberOfFrames;
  const left = new Float32Array(frames);
  sample.copyTo(left, { planeIndex: 0, format: "f32-planar" });
  if (sample.numberOfChannels < 2) return [left, left.slice()];
  const right = new Float32Array(frames);
  sample.copyTo(right, { planeIndex: 1, format: "f32-planar" });
  return [left, right];
}

type AudioChunk = { left: Float32Array; right: Float32Array; frames: number; timestamp: number; sampleRate: number };

/**
 * Runs the edited audio through the effects engine and hands processed stereo
 * chunks to `emit`, on the edited timeline. The engine's look-ahead latency is
 * compensated (the first `latency` output frames are dropped and the end is
 * flushed), so processed audio stays sample-aligned with the video. Fades use
 * the same curve as the preview; `gain` applies peak normalization.
 */
async function renderProcessedAudio(
  track: InputAudioTrack,
  segments: Range[],
  fx: AudioFx | null,
  editedSeconds: number,
  gain: number,
  emit: (chunk: AudioChunk) => Promise<void>
) {
  const sampleRate = await track.getSampleRate();
  const engine = createAudioEngine(sampleRate);
  // No effects: the engine bypasses, so this path just copies the audio.
  engine.configure(fx ?? { ...defaultFx(), enabled: false });
  const latency = engine.latency();
  const fadeIn = fx?.enabled ? fx.fadeInMs : 0;
  const fadeOut = fx?.enabled ? fx.fadeOutMs : 0;
  let skip = latency;
  let lastEnd = 0;

  const finish = async (left: Float32Array, right: Float32Array, timestamp: number) => {
    if (fadeIn > 0 || fadeOut > 0 || gain !== 1) {
      for (let i = 0; i < left.length; i++) {
        const g = gain * fadeGainAt(timestamp + i / sampleRate, editedSeconds, fadeIn, fadeOut);
        left[i] *= g;
        right[i] *= g;
      }
    }
    await emit({ left, right, frames: left.length, timestamp, sampleRate });
  };

  for await (const { sample, editedTs } of editedAudio(track, segments)) {
    const [left, right] = stereoPlanes(sample);
    const frames = sample.numberOfFrames;
    sample.close();
    engine.process(left, right, frames);
    lastEnd = editedTs + frames / sampleRate;
    let start = 0;
    if (skip > 0) {
      start = Math.min(skip, frames);
      skip -= start;
    }
    if (start >= frames) continue;
    await finish(left.subarray(start), right.subarray(start), Math.max(0, editedTs + (start - latency) / sampleRate));
  }
  if (latency > 0) {
    // Flush the look-ahead: the last `latency` frames are still inside it.
    const left = new Float32Array(latency), right = new Float32Array(latency);
    engine.process(left, right, latency);
    await finish(left, right, Math.max(0, lastEnd - latency / sampleRate));
  }
}

/** Peak of the processed audio, for two-pass normalization. */
async function measurePeak(track: InputAudioTrack, segments: Range[], fx: AudioFx, editedSeconds: number) {
  let peak = 0;
  await renderProcessedAudio(track, segments, fx, editedSeconds, 1, async ({ left, right }) => {
    for (let i = 0; i < left.length; i++) {
      const a = Math.abs(left[i]), b = Math.abs(right[i]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
  });
  return peak;
}

/**
 * AAC encoders prepend "priming" samples (measured here: 2112 frames, 44 ms
 * at 48 kHz; other platforms' encoders use different amounts). Without an
 * edit list telling players to skip them, every exported MP4 played its
 * audio that much late. mediabunny writes an edit list whenever a track starts
 * at a negative timestamp, so audio is labelled `delay` seconds early.
 *
 * The delay is measured, not assumed: a click is encoded and decoded through
 * the same WebCodecs encoder and the decoded click's position gives the delay.
 * Opus carries its own pre-skip in its header, so it needs nothing. Returns
 * frames (0 if it can't be measured, which keeps the old behaviour).
 */
async function measureAacDelay(sampleRate: number, channels: number): Promise<number> {
  if (typeof AudioEncoder === "undefined" || typeof AudioDecoder === "undefined") return 0;
  try {
    const codec = "mp4a.40.2";
    const chunks: EncodedAudioChunk[] = [];
    let description: AllowSharedBufferSource | undefined;
    const encoder = new AudioEncoder({
      output: (chunk, meta) => {
        chunks.push(chunk);
        if (meta?.decoderConfig?.description) description = meta.decoderConfig.description;
      },
      error: () => {},
    });
    encoder.configure({ codec, sampleRate, numberOfChannels: channels, bitrate: 128_000 });
    const frames = Math.round(sampleRate * 0.3);
    const at = Math.round(sampleRate * 0.1);
    const data = new Float32Array(frames * channels);
    for (let c = 0; c < channels; c++) data[c * frames + at] = 0.9;
    encoder.encode(new AudioData({ format: "f32-planar", sampleRate, numberOfFrames: frames, numberOfChannels: channels, timestamp: 0, data }));
    await encoder.flush();
    encoder.close();

    const decoded: Float32Array[] = [];
    const decoder = new AudioDecoder({
      output: (d) => {
        const plane = new Float32Array(d.numberOfFrames);
        d.copyTo(plane, { planeIndex: 0, format: "f32-planar" });
        decoded.push(plane);
        d.close();
      },
      error: () => {},
    });
    decoder.configure({ codec, sampleRate, numberOfChannels: channels, description });
    for (const c of chunks) decoder.decode(c);
    await decoder.flush();
    decoder.close();

    let index = 0, best = 0, pos = 0;
    for (const plane of decoded) {
      for (let i = 0; i < plane.length; i++, pos++) {
        if (Math.abs(plane[i]) > best) { best = Math.abs(plane[i]); index = pos; }
      }
    }
    const delay = index - at;
    return best > 0.1 && delay > 0 && delay < sampleRate * 0.2 ? delay : 0;
  } catch {
    return 0;
  }
}

/**
 * Longest a composited frame may be held. Screen recordings are often
 * variable-frame-rate (a static screen produces no new frames for seconds),
 * so a caption that changes mid-hold needs frames of its own.
 */
const MAX_HOLD = 1 / 30;

/** Normalization gain: peak → target, capped at +24 dB so silence isn't amplified into noise. */
const normalizeGain = (peak: number, targetDb: number) =>
  peak > 0 ? Math.min(Math.pow(10, targetDb / 20) / peak, Math.pow(10, 24 / 20)) : 1;

self.onmessage = async (msg: MessageEvent<ExportRequest>) => {
  if (msg.data.type !== "export") return;
  const { url, segments, preset } = msg.data;
  const outputKind: "mp4" | "wav" = msg.data.output ?? "mp4";
  const fx = msg.data.audioFx && isFxActive(msg.data.audioFx) ? msg.data.audioFx : null;
  const t0 = performance.now();
  try {
    if (segments.length === 0) throw new Error("Nothing to export — every part of the video is cut.");

    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url, { getRetryDelay: retryDelay }) });
    const editedSecondsAll = segments.reduce((s, r) => s + (r.end - r.start), 0);

    if (outputKind === "wav") {
      const aTrack = await input.getPrimaryAudioTrack();
      if (!aTrack) throw new Error("This video has no audio track to export.");
      if (!(await aTrack.canDecode())) throw new Error("This browser can't decode the source audio codec.");
      post({ type: "start", output: outputKind, width: 0, height: 0, videoCodec: null, audioCodec: "pcm-s16", editedSeconds: editedSecondsAll, audioProcessed: !!fx, captionsBurned: 0 });
      const gain = fx?.normalize.enabled
        ? normalizeGain(await measurePeak(aTrack, segments, fx, editedSecondsAll), fx.normalize.targetDb)
        : 1;
      let wav: WavWriter | null = null;
      let lastReport = 0;
      await renderProcessedAudio(aTrack, segments, fx, editedSecondsAll, gain, async (c) => {
        wav ??= new WavWriter(c.sampleRate, 2);
        wav.push(c.left, c.right, c.frames);
        const now = performance.now();
        if (now - lastReport > 150) {
          lastReport = now;
          post({ type: "progress", fraction: Math.min(1, (c.timestamp + c.frames / c.sampleRate) / editedSecondsAll) });
        }
      });
      if (!wav) throw new Error("Export produced no audio.");
      const buffer = (wav as WavWriter).finish();
      post({ type: "progress", fraction: 1 });
      post({ type: "done", buffer, ms: performance.now() - t0 }, [buffer]);
      return;
    }

    const vTrack = await input.getPrimaryVideoTrack();
    if (!vTrack) throw new Error("The source has no video track.");
    if (!(await vTrack.canDecode())) throw new Error("This browser can't decode the source video codec.");
    const aTrack = await input.getPrimaryAudioTrack();
    const audioUsable = !!aTrack && (await aTrack.canDecode());

    // Output size: only ever downscale, keep aspect ratio, even dimensions.
    const srcW = await vTrack.getDisplayWidth();
    const srcH = await vTrack.getDisplayHeight();
    const cfg = EXPORT_PRESETS[preset];
    const scale = cfg.maxHeight && srcH > cfg.maxHeight ? cfg.maxHeight / srcH : 1;
    const width = even(srcW * scale);
    const height = even(srcH * scale);

    // Negotiate codecs the device can actually encode. AAC isn't available
    // for encoding everywhere (e.g. Firefox), so Opus is the fallback.
    const videoCodec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1"], { width, height });
    if (!videoCodec) throw new Error("This browser can't encode video (WebCodecs unavailable).");
    // Processed audio is always stereo (see dsp.ts), so encode two channels.
    const processAudio = audioUsable && !!fx;
    const audioCodec = audioUsable
      ? await getFirstEncodableAudioCodec(["aac", "opus"], {
          numberOfChannels: processAudio ? 2 : await aTrack!.getNumberOfChannels(),
          sampleRate: await aTrack!.getSampleRate(),
        })
      : null;

    // Burned-in captions: composite each frame on a canvas at output size.
    let burn: { captions: Caption[]; style: CaptionStyle; ctx: OffscreenCanvasRenderingContext2D; canvas: OffscreenCanvas } | null = null;
    if (msg.data.captions && msg.data.captions.captions.length > 0) {
      if (typeof OffscreenCanvas === "undefined") throw new Error("This browser can't burn in captions (no OffscreenCanvas).");
      const style = sanitizeCaptionStyle(msg.data.captions.style);
      const mapped = captionsForSegments(msg.data.captions.captions, segments);
      if (mapped.length > 0) {
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("This browser can't burn in captions (no 2D canvas in workers).");
        // Same font files as the preview; falls back to a system font if offline.
        await loadCaptionFont(style, self.location.origin);
        burn = { captions: mapped, style, ctx, canvas };
      }
    }

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });
    const videoSource = new VideoSampleSource({
      codec: videoCodec,
      bitrate: QUALITY[cfg.quality],
      // `fit` is required at runtime whenever both dimensions are given (the
      // type marks it optional). The size already keeps the source aspect
      // ratio, so "fill" only absorbs sub-pixel rounding to even dimensions,
      // where "contain" could leave a 1 px black edge.
      // (When compositing, frames are already drawn at the output size.)
      transform: scale < 1 && !burn ? { width, height, fit: "fill" } : undefined,
    });
    output.addVideoTrack(videoSource);
    const audioSource = audioCodec ? new AudioSampleSource({ codec: audioCodec, bitrate: QUALITY_HIGH }) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    const editedSeconds = segments.reduce((s, r) => s + (r.end - r.start), 0);
    post({ type: "start", output: outputKind, width, height, videoCodec, audioCodec, editedSeconds, audioProcessed: processAudio && !!audioCodec, captionsBurned: burn?.captions.length ?? 0 });

    // Progress is driven by the video track (the expensive one).
    let videoDone = 0;
    let lastReport = 0;
    const report = () => {
      const now = performance.now();
      if (now - lastReport > 150) {
        lastReport = now;
        post({ type: "progress", fraction: Math.min(1, videoDone / editedSeconds) });
      }
    };

    const encodeVideo = async () => {
      const sink = new VideoSampleSink(vTrack);
      let offset = 0;
      let wroteVideo = false;
      for (const seg of segments) {
        for await (const sample of sink.samples(Math.max(0, seg.start - PREROLL), seg.end)) {
          const ts = sample.timestamp;
          const end = ts + sample.duration;
          // Keep a frame if any part of it is visible inside the segment.
          if (end <= seg.start || ts >= seg.end) { sample.close(); continue; }
          const visibleStart = Math.max(ts, seg.start);
          const visibleEnd = Math.min(end, seg.end);
          // A frame less than half inside the segment is a sliver at a cut
          // point (measured: 13 ms). Dropping it lets the neighbouring frame
          // hold instead, which is invisible and avoids near-duplicate
          // timestamps that strict players and remuxers reject. The first
          // frame is always kept so the output starts at zero.
          if (wroteVideo && visibleEnd - visibleStart < sample.duration / 2) { sample.close(); continue; }
          wroteVideo = true;
          const editedStart = offset + (visibleStart - seg.start);
          const editedLen = visibleEnd - visibleStart;
          if (burn) {
            // Draw the frame once per hold step, with the caption as it is at
            // that moment; a long-held frame becomes several short ones.
            const steps = Math.max(1, Math.ceil(editedLen / MAX_HOLD - 0.5));
            for (let k = 0; k < steps; k++) {
              const t0 = editedStart + (editedLen * k) / steps;
              const t1 = editedStart + (editedLen * (k + 1)) / steps;
              const { ctx, canvas, captions: caps, style } = burn;
              sample.draw(ctx, 0, 0, width, height);
              drawCaption(ctx, captionAt(caps, t0), t0, style, width, height);
              const frame = new VideoSample(canvas, { timestamp: t0, duration: t1 - t0 });
              await videoSource.add(frame);
              frame.close();
            }
          } else {
            sample.setTimestamp(editedStart);
            sample.setDuration(editedLen);
            await videoSource.add(sample);
          }
          sample.close();
          videoDone = offset + (visibleEnd - seg.start);
          report();
        }
        offset += seg.end - seg.start;
      }
      videoSource.close();
    };

    const encodeAudio = async () => {
      if (!audioSource || !aTrack) return;
      const encSampleRate = await aTrack.getSampleRate();
      const encChannels = processAudio ? 2 : await aTrack.getNumberOfChannels();
      const shift = audioCodec === "aac" ? (await measureAacDelay(encSampleRate, encChannels)) / encSampleRate : 0;
      if (processAudio && fx) {
        const gain = fx.normalize.enabled
          ? normalizeGain(await measurePeak(aTrack, segments, fx, editedSeconds), fx.normalize.targetDb)
          : 1;
        await renderProcessedAudio(aTrack, segments, fx, editedSeconds, gain, async (c) => {
          const data = new Float32Array(c.frames * 2);
          data.set(c.left.subarray(0, c.frames), 0);
          data.set(c.right.subarray(0, c.frames), c.frames);
          const sample = new AudioSample({
            data,
            format: "f32-planar",
            numberOfChannels: 2,
            sampleRate: c.sampleRate,
            timestamp: c.timestamp - shift,
          });
          await audioSource.add(sample);
          sample.close();
        });
      } else {
        // No effects: the original samples, sample-accurately trimmed.
        for await (const { sample, editedTs } of editedAudio(aTrack, segments)) {
          sample.setTimestamp(editedTs - shift);
          await audioSource.add(sample);
          sample.close();
        }
      }
      audioSource.close();
    };

    // Concurrent so the muxer can interleave tracks instead of buffering one.
    await Promise.all([encodeVideo(), encodeAudio()]);
    await output.finalize();

    const buffer = output.target.buffer;
    if (!buffer) throw new Error("Export produced no data.");
    post({ type: "progress", fraction: 1 });
    post({ type: "done", buffer, ms: performance.now() - t0 }, [buffer]);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
