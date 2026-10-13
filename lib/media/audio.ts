// Loads a video's audio for analysis, once, in the shape every consumer
// wants: 16 kHz mono Float32 PCM. Whisper requires exactly that; silence
// detection and waveform drawing don't need more resolution.
//
// Memory: the browser never downloads the video for this. Cloudinary serves
// an audio-only rendition of any video by swapping the extension to .mp3
// (~100 kbps, measured ≈0.75 MB/min, CORS: *). The decoded 16 kHz buffer is
// 64 KB per second of audio (~3.8 MB/min), so a 30-minute recording is
// ~115 MB in memory — the practical ceiling this approach accepts.

export const ANALYSIS_SAMPLE_RATE = 16_000;

/** Cloudinary audio-only rendition of a delivered video URL. */
export function audioRenditionUrl(videoUrl: string): string {
  if (!videoUrl.includes("res.cloudinary.com")) return videoUrl;
  return videoUrl.replace(/\.[a-z0-9]+(\?.*)?$/i, ".mp3");
}

export interface LoadedAudio {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
  /** Bytes transferred, for honest reporting. */
  bytes: number;
}

/** Streams a URL into memory, reporting real byte progress (0..1 when known). */
async function fetchWithProgress(
  url: string,
  onProgress: (fraction: number | null) => void,
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Couldn't load audio (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return res.arrayBuffer();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(total ? received / total : null);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out.buffer;
}

/**
 * Downloads and decodes a video's audio to 16 kHz mono. OfflineAudioContext
 * resamples during decode, so no manual resampling code is needed; channels
 * are averaged to mono.
 */
export async function loadAnalysisAudio(
  videoUrl: string,
  onProgress: (fraction: number | null) => void = () => {},
  signal?: AbortSignal
): Promise<LoadedAudio> {
  const data = await fetchWithProgress(audioRenditionUrl(videoUrl), onProgress, signal);
  const bytes = data.byteLength;
  const ctx = new OfflineAudioContext(1, ANALYSIS_SAMPLE_RATE, ANALYSIS_SAMPLE_RATE);
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(data);
  } catch {
    // Most often a recording made without a microphone: there is no audio
    // track, so there is nothing to transcribe or tighten.
    throw new Error("This video has no audio track the browser can decode, so there's nothing to analyse.");
  }

  let samples: Float32Array;
  if (buffer.numberOfChannels === 1) {
    samples = buffer.getChannelData(0).slice();
  } else {
    samples = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const ch = buffer.getChannelData(c);
      for (let i = 0; i < ch.length; i++) samples[i] += ch[i] / buffer.numberOfChannels;
    }
  }
  return { samples, sampleRate: buffer.sampleRate, duration: buffer.duration, bytes };
}
