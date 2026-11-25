/// <reference lib="webworker" />
// Re-encodes a video that is over the upload limit, on this device, to MP4
// (H.264 + AAC) at the size and bitrate from planCompression. Nothing is
// uploaded from here.

import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, getFirstEncodableAudioCodec, getFirstEncodableVideoCodec } from "mediabunny";
import { planCompression, maxCompressibleSeconds } from "./plan";

export type CompressEvent =
  | { type: "progress"; fraction: number }
  | { type: "done"; buffer: ArrayBuffer; seconds: number; width: number; height: number }
  | { type: "error"; message: string };

const post = (e: CompressEvent, t: Transferable[] = []) => (self as unknown as Worker).postMessage(e, t);

self.onmessage = async (msg: MessageEvent<{ file: Blob; targetBytes?: number }>) => {
  try {
    if (typeof VideoEncoder === "undefined") {
      throw new Error("This browser can't compress video. Update it, or use a desktop browser, or upload a clip under 100 MB.");
    }
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(msg.data.file) });
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("This file has no video track.");
    if (!(await track.canDecode())) throw new Error(`This browser can't decode this video's format (${track.codec ?? "unknown codec"}). Try recording in "Most compatible" (H.264) mode.`);
    const seconds = await input.computeDuration();
    const plan = planCompression(seconds, track.displayWidth, track.displayHeight, msg.data.targetBytes);
    if (!plan) {
      throw new Error(`This video is too long to fit the 100 MB upload limit. Trim it to under ${Math.floor(maxCompressibleSeconds(msg.data.targetBytes) / 60)} minutes and try again.`);
    }
    const videoCodec = await getFirstEncodableVideoCodec(["avc", "hevc", "vp9", "av1"], { width: plan.width, height: plan.height, bitrate: plan.videoBps });
    if (!videoCodec) throw new Error("This browser can't encode video. Use a desktop browser, or upload a clip under 100 MB.");
    const audioCodec = await getFirstEncodableAudioCodec(["aac", "opus"], { bitrate: plan.audioBps });

    const output = new Output({ format: new Mp4OutputFormat({ fastStart: "in-memory" }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input, output,
      video: { width: plan.width, height: plan.height, fit: "fill", codec: videoCodec, bitrate: plan.videoBps, forceTranscode: true },
      audio: audioCodec ? { codec: audioCodec, bitrate: plan.audioBps, numberOfChannels: 2 } : { discard: true },
    });
    if (!conversion.isValid) {
      const why = conversion.discardedTracks.map((d) => `${d.track.type}: ${d.reason}`).join(", ");
      throw new Error(`Couldn't compress this video (${why}).`);
    }
    let last = 0;
    conversion.onProgress = (p) => {
      const now = performance.now();
      if (now - last > 200) { last = now; post({ type: "progress", fraction: p }); }
    };
    await conversion.execute();
    const buffer = output.target.buffer!;
    input.dispose();
    post({ type: "done", buffer, seconds, width: plan.width, height: plan.height }, [buffer]);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
