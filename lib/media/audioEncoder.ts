// Encodes a stream of stereo PCM chunks into an audio file, in a worker.
// Shared by the editor's export (edited + processed + mixed audio) and the
// Convert tool (any local video or audio file).

import {
  AudioSample, AudioSampleSource, BufferTarget, canEncodeAudio, Mp3OutputFormat, Mp4OutputFormat, OggOutputFormat, Output,
} from "mediabunny";
import { registerMp3Encoder } from "@mediabunny/mp3-encoder";
import { WavWriter } from "@/lib/studio/wav";
import { AUDIO_FORMATS, maxKbps, type AudioFormatId } from "./audioFormats";

export type PushChunk = (left: Float32Array, right: Float32Array, frames: number, timestamp: number) => Promise<void>;

let mp3Registered = false;

/** Whether this browser can produce `format` (MP3 always can, via WebAssembly). */
export async function canProduce(format: AudioFormatId, sampleRate: number): Promise<boolean> {
  const codec = AUDIO_FORMATS[format].codec;
  if (!codec || codec === "mp3") return true;
  return canEncodeAudio(codec, { numberOfChannels: 2, sampleRate });
}

/**
 * Opus is only defined at 48 kHz (WebCodecs rejects other rates), so other
 * rates are resampled for it; everything else keeps the source rate.
 */
export const encodeRate = (format: AudioFormatId, sourceRate: number) => (format === "opus" ? 48000 : sourceRate);

/**
 * Runs `produce`, which pushes contiguous stereo chunks at `sampleRate`, and
 * returns the encoded file. Chunks for Opus are resampled to 48 kHz here.
 */
export async function encodeAudioFile(
  format: AudioFormatId,
  kbps: number,
  sampleRate: number,
  produce: (push: PushChunk) => Promise<void>
): Promise<ArrayBuffer> {
  if (format === "wav") {
    const wav = new WavWriter(sampleRate, 2);
    await produce(async (l, r, n) => { wav.push(l, r, n); });
    return wav.finish();
  }
  const info = AUDIO_FORMATS[format];
  if (format === "mp3" && !mp3Registered && !(await canEncodeAudio("mp3"))) {
    registerMp3Encoder();
    mp3Registered = true;
  }
  const outRate = encodeRate(format, sampleRate);
  if (!(await canProduce(format, outRate))) throw new Error(`This browser can't encode ${info.label}.`);

  const output = new Output({
    format: format === "mp3" ? new Mp3OutputFormat() : format === "m4a" ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new OggOutputFormat(),
    target: new BufferTarget(),
  });
  const source = new AudioSampleSource({ codec: info.codec!, bitrate: Math.min(kbps, maxKbps(format)) * 1000 });
  output.addAudioTrack(source);
  await output.start();

  const resample = outRate !== sampleRate ? makeResampler(sampleRate, outRate) : null;
  // AAC priming: label the audio early so the MP4 edit list trims it (see measureAacDelay).
  const shift = info.codec === "aac" ? (await measureAacDelay(outRate, 2)) / outRate : 0;
  let written = 0;
  await produce(async (l, r, n) => {
    let left = l.subarray(0, n), right = r.subarray(0, n);
    if (resample) [left, right] = resample(left, right);
    if (left.length === 0) return;
    const data = new Float32Array(left.length * 2);
    data.set(left, 0);
    data.set(right, left.length);
    const sample = new AudioSample({ data, format: "f32-planar", numberOfChannels: 2, sampleRate: outRate, timestamp: written / outRate - shift });
    written += left.length;
    await source.add(sample);
    sample.close();
  });
  source.close();
  await output.finalize();
  const buf = output.target.buffer;
  if (!buf) throw new Error("Encoding produced no data.");
  return buf;
}

/**
 * Streaming linear-interpolation resampler (stateful across chunks). Good
 * enough for Opus delivery of 44.1 kHz material; aliasing stays far below
 * what a lossy codec discards.
 */
export function makeResampler(from: number, to: number) {
  const step = from / to;
  let pos = 0; // read position, relative to the start of the pending buffer
  let pendL = new Float32Array(0), pendR = new Float32Array(0);
  return (l: Float32Array, r: Float32Array): [Float32Array, Float32Array] => {
    const L = new Float32Array(pendL.length + l.length); L.set(pendL); L.set(l, pendL.length);
    const R = new Float32Array(pendR.length + r.length); R.set(pendR); R.set(r, pendR.length);
    const outL: number[] = [], outR: number[] = [];
    while (pos + 1 < L.length) {
      const k = Math.floor(pos), f = pos - k;
      outL.push(L[k] + (L[k + 1] - L[k]) * f);
      outR.push(R[k] + (R[k + 1] - R[k]) * f);
      pos += step;
    }
    const keep = Math.floor(pos);
    pendL = L.slice(keep); pendR = R.slice(keep);
    pos -= keep;
    return [Float32Array.from(outL), Float32Array.from(outR)];
  };
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
export async function measureAacDelay(sampleRate: number, channels: number): Promise<number> {
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
