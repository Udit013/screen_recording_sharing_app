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
  VideoSampleSink,
  VideoSampleSource,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from "mediabunny";
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

self.onmessage = async (msg: MessageEvent<ExportRequest>) => {
  if (msg.data.type !== "export") return;
  const { url, segments, preset } = msg.data;
  const t0 = performance.now();
  try {
    if (segments.length === 0) throw new Error("Nothing to export — every part of the video is cut.");

    const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url, { getRetryDelay: retryDelay }) });
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
    const audioCodec = audioUsable
      ? await getFirstEncodableAudioCodec(["aac", "opus"], {
          numberOfChannels: await aTrack!.getNumberOfChannels(),
          sampleRate: await aTrack!.getSampleRate(),
        })
      : null;

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
      transform: scale < 1 ? { width, height, fit: "fill" } : undefined,
    });
    output.addVideoTrack(videoSource);
    const audioSource = audioCodec ? new AudioSampleSource({ codec: audioCodec, bitrate: QUALITY_HIGH }) : null;
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();

    const editedSeconds = segments.reduce((s, r) => s + (r.end - r.start), 0);
    post({ type: "start", width, height, videoCodec, audioCodec, editedSeconds });

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
          sample.setTimestamp(offset + (visibleStart - seg.start));
          sample.setDuration(visibleEnd - visibleStart);
          await videoSource.add(sample);
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
      const sink = new AudioSampleSink(aTrack);
      let offset = 0;
      for (const seg of segments) {
        for await (const sample of sink.samples(Math.max(0, seg.start - PREROLL), seg.end)) {
          const ts = sample.timestamp;
          const sr = sample.sampleRate;
          // Sample-accurate trim to the segment boundaries.
          const from = Math.max(0, Math.round((seg.start - ts) * sr));
          const to = Math.min(sample.numberOfFrames, Math.round((seg.end - ts) * sr));
          if (to <= from) { sample.close(); continue; }
          const piece = from === 0 && to === sample.numberOfFrames ? sample : sample.trim(from, to);
          piece.setTimestamp(offset + (ts + from / sr - seg.start));
          await audioSource.add(piece);
          if (piece !== sample) piece.close();
          sample.close();
        }
        offset += seg.end - seg.start;
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
