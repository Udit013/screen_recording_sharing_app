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
import { encodeAudioFile, measureAacDelay } from "./audioEncoder";
import { mp3StartTrim, readHead } from "./gapless";
import { AUDIO_FORMATS, DEFAULT_AUDIO_KBPS } from "./audioFormats";
import { captionAt, captionsForSegments, sanitizeCaptionStyle, type Caption, type CaptionStyle } from "@/lib/studio/captions";
import { drawCaption, loadCaptionFont } from "@/lib/studio/captionRender";
import { drawFrame, isIdentityLook, outputSize, sanitizeLook, type VideoLook } from "@/lib/studio/frame";
import { dbToGain, isPlainMix, mixInto, type AudioMix, type DecodedClip } from "@/lib/studio/tracks";
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
  emit: (chunk: AudioChunk) => Promise<void>,
  applyFades = true
) {
  const sampleRate = await track.getSampleRate();
  const engine = createAudioEngine(sampleRate);
  // No effects: the engine bypasses, so this path just copies the audio.
  engine.configure(fx ?? { ...defaultFx(), enabled: false });
  const latency = engine.latency();
  const fadeIn = applyFades && fx?.enabled ? fx.fadeInMs : 0;
  const fadeOut = applyFades && fx?.enabled ? fx.fadeOutMs : 0;
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

/**
 * Decodes the part of each added clip that can play inside the export, at the
 * asset's own sample rate (the mixer interpolates). Clips that start after
 * the end of the export are skipped; one that can't be decoded fails the
 * export with its name, rather than silently dropping a track.
 */
async function decodeClips(mix: AudioMix, editedSeconds: number, onProgress: (done: number, total: number) => void) {
  const decoded = new Map<string, DecodedClip>();
  const clips = mix.tracks.filter((t) => !t.muted).flatMap((t) => t.clips).filter((c) => c.start < editedSeconds);
  let done = 0;
  for (const c of clips) {
    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(c.url, { getRetryDelay: retryDelay }) });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track || !(await track.canDecode())) throw new Error("unsupported audio");
      const sr = await track.getSampleRate();
      // MP3: the decoder's output starts with encoder + decoder delay (gapless.ts).
      const skip = track.codec === "mp3" ? (mp3StartTrim(await readHead(c.url)) ?? 0) / sr : 0;
      const from = c.in;
      const to = Math.min(c.out, c.in + (editedSeconds - c.start)) + 0.05;
      const frames = Math.ceil((to - from) * sr) + 2;
      const left = new Float32Array(frames), right = new Float32Array(frames);
      const sink = new AudioSampleSink(track);
      for await (const sample of sink.samples(Math.max(0, from + skip - 0.05), to + skip)) {
        const [l, r] = stereoPlanes(sample);
        const off = Math.round((sample.timestamp - skip - from) * sr);
        sample.close();
        for (let i = 0; i < l.length; i++) {
          const k = off + i;
          if (k >= 0 && k < frames) { left[k] = l[i]; right[k] = r[i]; }
        }
      }
      decoded.set(c.id, { left, right, from, sampleRate: sr });
    } catch (err) {
      throw new Error(`Couldn't decode the added audio "${c.name}" (${err instanceof Error ? err.message : "error"}).`);
    } finally {
      input.dispose();
    }
    onProgress(++done, clips.length);
  }
  return decoded;
}

/**
 * The final audio: the original (through the effects chain, at its level,
 * or silence when muted/absent) plus every added clip, then the master fades
 * and normalization gain over the whole mix. Emits contiguous stereo chunks
 * covering exactly [0, editedSeconds).
 */
async function renderFinalAudio(
  track: InputAudioTrack | null,
  segments: Range[],
  fx: AudioFx | null,
  editedSeconds: number,
  mix: AudioMix,
  decoded: Map<string, DecodedClip>,
  gain: number,
  emit: (chunk: AudioChunk) => Promise<void>
) {
  const fadeIn = fx?.enabled ? fx.fadeInMs : 0;
  const fadeOut = fx?.enabled ? fx.fadeOutMs : 0;
  const origGain = mix.original.muted ? 0 : dbToGain(mix.original.gainDb);
  const sampleRate = track ? await track.getSampleRate() : 48000;
  const total = Math.round(editedSeconds * sampleRate);
  let written = 0;

  const finish = async (left: Float32Array, right: Float32Array, frames: number) => {
    const t0 = written / sampleRate;
    mixInto(mix, decoded, left, right, frames, t0, sampleRate);
    for (let i = 0; i < frames; i++) {
      const g = gain * fadeGainAt((written + i) / sampleRate, editedSeconds, fadeIn, fadeOut);
      left[i] *= g;
      right[i] *= g;
    }
    await emit({ left, right, frames, timestamp: t0, sampleRate });
    written += frames;
  };

  if (track) {
    await renderProcessedAudio(track, segments, fx, editedSeconds, 1, async (c) => {
      // Place each chunk at its frame position; pad any gap with silence.
      const at = Math.round(c.timestamp * sampleRate);
      while (written < Math.min(at, total)) {
        const n = Math.min(4096, Math.min(at, total) - written);
        await finish(new Float32Array(n), new Float32Array(n), n);
      }
      const skip = Math.max(0, written - at);
      const n = Math.min(c.frames - skip, total - written);
      if (n <= 0) return;
      const left = c.left.slice(skip, skip + n), right = c.right.slice(skip, skip + n);
      if (origGain !== 1) for (let i = 0; i < n; i++) { left[i] *= origGain; right[i] *= origGain; }
      await finish(left, right, n);
    }, false);
  }
  while (written < total) {
    const n = Math.min(4096, total - written);
    await finish(new Float32Array(n), new Float32Array(n), n);
  }
}

/** Peak of everything a render emits, for two-pass normalization. */
async function peakOf(render: (emit: (c: AudioChunk) => Promise<void>) => Promise<void>) {
  let peak = 0;
  await render(async ({ left, right, frames }) => {
    for (let i = 0; i < frames; i++) {
      const a = Math.abs(left[i]), b = Math.abs(right[i]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
  });
  return peak;
}

const countClips = (m: AudioMix) => m.tracks.filter((t) => !t.muted).reduce((n, t) => n + t.clips.length, 0);


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
  const outputKind = msg.data.output ?? "mp4";
  const fx = msg.data.audioFx && isFxActive(msg.data.audioFx) ? msg.data.audioFx : null;
  // Multitrack: anything beyond "the original audio, untouched" goes through the mixer.
  const mix: AudioMix | null = msg.data.mix && !isPlainMix(msg.data.mix) ? msg.data.mix : null;
  const t0 = performance.now();
  try {
    if (segments.length === 0) throw new Error("Nothing to export — every part of the video is cut.");

    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url, { getRetryDelay: retryDelay }) });
    const editedSecondsAll = segments.reduce((s, r) => s + (r.end - r.start), 0);

    if (outputKind !== "mp4") {
      const srcAudio = await input.getPrimaryAudioTrack();
      if (srcAudio && !(await srcAudio.canDecode())) throw new Error("This browser can't decode the source audio codec.");
      if (!srcAudio && !mix) throw new Error("This video has no audio track to export.");
      const aTrack = srcAudio;
      post({ type: "start", output: outputKind, width: 0, height: 0, videoCodec: null, audioCodec: outputKind === "wav" ? "pcm-s16" : AUDIO_FORMATS[outputKind].codec, editedSeconds: editedSecondsAll, audioProcessed: !!fx, captionsBurned: 0, tracksMixed: mix ? countClips(mix) : 0 });
      const decoded = mix ? await decodeClips(mix, editedSecondsAll, () => {}) : null;
      const render = (g: number, emit: (c: AudioChunk) => Promise<void>) =>
        mix ? renderFinalAudio(aTrack, segments, fx, editedSecondsAll, mix, decoded!, g, emit)
          : renderProcessedAudio(aTrack!, segments, fx, editedSecondsAll, g, emit);
      const gain = fx?.normalize.enabled
        ? normalizeGain(await peakOf((emit) => render(1, emit)), fx.normalize.targetDb)
        : 1;
      let lastReport = 0;
      const sampleRate = aTrack ? await aTrack.getSampleRate() : 48000;
      // WAV is written directly; MP3 (LAME/WASM), AAC and Opus (WebCodecs)
      // go through the shared encoder.
      const buffer = await encodeAudioFile(outputKind, msg.data.audioKbps ?? DEFAULT_AUDIO_KBPS, sampleRate, (push) =>
        render(gain, async (c) => {
          await push(c.left, c.right, c.frames, c.timestamp);
          const now = performance.now();
          if (now - lastReport > 150) {
            lastReport = now;
            post({ type: "progress", fraction: Math.min(1, (c.timestamp + c.frames / c.sampleRate) / editedSecondsAll) });
          }
        }));
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
    // A reframe (Video tab) sets its own shape; the preset bounds its short side.
    const srcW = await vTrack.getDisplayWidth();
    const srcH = await vTrack.getDisplayHeight();
    const cfg = EXPORT_PRESETS[preset];
    const look: VideoLook | null = msg.data.look ? sanitizeLook(msg.data.look) : null;
    const framed = !!look && !isIdentityLook(look);
    const scale = cfg.maxHeight && srcH > cfg.maxHeight ? cfg.maxHeight / srcH : 1;
    const size = framed ? outputSize(srcW, srcH, look!, cfg.maxHeight) : { width: even(srcW * scale), height: even(srcH * scale) };
    const { width, height } = size;

    // Negotiate codecs the device can actually encode. AAC isn't available
    // for encoding everywhere (e.g. Firefox), so Opus is the fallback.
    const videoCodec = await getFirstEncodableVideoCodec(["avc", "vp9", "av1"], { width, height });
    if (!videoCodec) throw new Error("This browser can't encode video (WebCodecs unavailable).");
    // Processed audio is always stereo (see dsp.ts), so encode two channels.
    const processAudio = (audioUsable && !!fx) || !!mix;
    const hasAudio = audioUsable || !!mix;
    const audioCodec = hasAudio
      ? await getFirstEncodableAudioCodec(["aac", "opus"], {
          numberOfChannels: processAudio ? 2 : await aTrack!.getNumberOfChannels(),
          sampleRate: audioUsable ? await aTrack!.getSampleRate() : 48000,
        })
      : null;

    // Compositing (framing and/or burned-in captions): each frame is drawn
    // on a canvas at output size by the same code as the preview.
    const caps = msg.data.captions && msg.data.captions.captions.length > 0
      ? { captions: captionsForSegments(msg.data.captions.captions, segments), style: sanitizeCaptionStyle(msg.data.captions.style) }
      : null;
    const captionsToBurn: { captions: Caption[]; style: CaptionStyle } | null = caps && caps.captions.length > 0 ? caps : null;
    let burn: { ctx: OffscreenCanvasRenderingContext2D; canvas: OffscreenCanvas } | null = null;
    if (framed || captionsToBurn) {
      if (typeof OffscreenCanvas === "undefined") throw new Error("This browser can't composite video in the background (no OffscreenCanvas).");
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("This browser can't composite video in the background (no 2D canvas in workers).");
      // Same font files as the preview; falls back to a system font if offline.
      if (captionsToBurn) await loadCaptionFont(captionsToBurn.style, self.location.origin);
      burn = { ctx, canvas };
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
    post({ type: "start", output: outputKind, width, height, videoCodec, audioCodec, editedSeconds, audioProcessed: !!fx && audioUsable && !!audioCodec, captionsBurned: captionsToBurn?.captions.length ?? 0, tracksMixed: mix && audioCodec ? countClips(mix) : 0 });

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
            // that moment; a long-held frame becomes several short ones. With
            // framing alone nothing changes during a hold, so one is enough.
            const steps = captionsToBurn ? Math.max(1, Math.ceil(editedLen / MAX_HOLD - 0.5)) : 1;
            for (let k = 0; k < steps; k++) {
              const t0 = editedStart + (editedLen * k) / steps;
              const t1 = editedStart + (editedLen * (k + 1)) / steps;
              const { ctx, canvas } = burn;
              if (framed) {
                ctx.clearRect(0, 0, width, height);
                drawFrame(ctx, (c, sx, sy, sw, sh, dx, dy, dw, dh) => sample.draw(c, sx, sy, sw, sh, dx, dy, dw, dh),
                  sample.displayWidth, sample.displayHeight, look!, width, height);
              } else {
                sample.draw(ctx, 0, 0, width, height);
              }
              if (captionsToBurn) drawCaption(ctx, captionAt(captionsToBurn.captions, t0), t0, captionsToBurn.style, width, height);
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

    // Added clips are fetched and decoded before encoding starts.
    const decoded = mix && audioCodec ? await decodeClips(mix, editedSeconds, () => {}) : null;

    const encodeAudio = async () => {
      if (!audioSource) return;
      const srcAudio = audioUsable ? aTrack! : null;
      const encSampleRate = srcAudio ? await srcAudio.getSampleRate() : 48000;
      const encChannels = processAudio ? 2 : await srcAudio!.getNumberOfChannels();
      const shift = audioCodec === "aac" ? (await measureAacDelay(encSampleRate, encChannels)) / encSampleRate : 0;
      if (processAudio) {
        const render = (g: number, emit: (c: AudioChunk) => Promise<void>) =>
          mix ? renderFinalAudio(srcAudio, segments, fx, editedSeconds, mix, decoded!, g, emit)
            : renderProcessedAudio(srcAudio!, segments, fx, editedSeconds, g, emit);
        const gain = fx?.normalize.enabled
          ? normalizeGain(await peakOf((emit) => render(1, emit)), fx.normalize.targetDb)
          : 1;
        await render(gain, async (c) => {
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
        for await (const { sample, editedTs } of editedAudio(aTrack!, segments)) {
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
