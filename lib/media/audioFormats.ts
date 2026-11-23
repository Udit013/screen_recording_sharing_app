// Audio output formats for exports and the Convert tool. All encoding runs in
// the browser: WAV is written directly, AAC and Opus use WebCodecs, MP3 uses
// LAME compiled to WebAssembly (@mediabunny/mp3-encoder, MPL-2.0 wrapper
// around the LGPL LAME encoder), because browsers don't encode MP3 natively.

export type AudioFormatId = "wav" | "mp3" | "m4a" | "opus";

export interface AudioFormatInfo {
  id: AudioFormatId;
  label: string;
  detail: string;
  ext: string;
  mime: string;
  /** WebCodecs/mediabunny codec, or null for uncompressed PCM. */
  codec: "mp3" | "aac" | "opus" | null;
}

export const AUDIO_FORMATS: Record<AudioFormatId, AudioFormatInfo> = {
  mp3: { id: "mp3", label: "MP3", detail: "Plays everywhere", ext: "mp3", mime: "audio/mpeg", codec: "mp3" },
  m4a: { id: "m4a", label: "M4A (AAC)", detail: "Smaller at the same quality", ext: "m4a", mime: "audio/mp4", codec: "aac" },
  opus: { id: "opus", label: "Opus (Ogg)", detail: "Smallest; best for voice", ext: "ogg", mime: "audio/ogg", codec: "opus" },
  wav: { id: "wav", label: "WAV", detail: "Lossless, large", ext: "wav", mime: "audio/wav", codec: null },
};

export const AUDIO_BITRATES = [64, 96, 128, 160, 192, 256, 320] as const;
export const DEFAULT_AUDIO_KBPS = 192;

/** Highest bitrate each codec accepts (Opus tops out lower than MP3). */
export const maxKbps = (f: AudioFormatId) => (f === "opus" ? 256 : 320);

/**
 * Estimated file size. Exact for WAV (16-bit PCM + 44-byte header); for lossy
 * formats it's the target bitrate × duration plus ~1% container overhead
 * (encoders land within a few percent of the target on music and speech).
 */
export function estimateAudioBytes(f: AudioFormatId, kbps: number, seconds: number, sampleRate = 48000, channels = 2): number {
  if (f === "wav") return 44 + Math.round(seconds * sampleRate) * channels * 2;
  return Math.round(((Math.min(kbps, maxKbps(f)) * 1000) / 8) * seconds * 1.01);
}

export const formatBytes = (b: number) =>
  b >= 1024 * 1024 ? `${(b / 1048576).toFixed(b >= 100 * 1048576 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
