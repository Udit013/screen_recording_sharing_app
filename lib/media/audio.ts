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
  const url = audioRenditionUrl(videoUrl);
  const warmed = warm.get(url);
  let data: ArrayBuffer;
  if (warmed) {
    // Taken, not shared: decoding detaches the buffer. Progress stays at 0
    // until it lands, so the editor's slow-first-load note still applies.
    warm.delete(url);
    try {
      data = await warmed;
      onProgress(1);
    } catch {
      data = await fetchWithProgress(url, onProgress, signal);
    }
  } else {
    data = await fetchWithProgress(url, onProgress, signal);
  }
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

// Downloads started on intent, keyed by rendition URL. Shared in memory
// rather than left to the HTTP cache: measured on the live site, an 8.5 MB
// rendition was not cached by the browser, so the editor downloaded it a
// second time. Handing over the in-flight promise guarantees one download.
const warm = new Map<string, Promise<ArrayBuffer>>();
/** URLs warmed recently, so hovering again after a visit doesn't re-download. */
const recentlyWarmed = new Set<string>();
/** Hovered but never opened: release the buffer instead of holding it. */
const WARM_TTL_MS = 120_000;

/**
 * Starts downloading a video's analysis audio before the editor opens, on a
 * signal of intent (hovering or focusing an Edit link). The editor opens via
 * client-side navigation, so loadAnalysisAudio picks up this same download.
 * It is the request the editor would make a moment later, so it adds no
 * Cloudinary work. Fire-and-forget; once per URL.
 */
export function prewarmAnalysisAudio(videoUrl: string): void {
  const url = audioRenditionUrl(videoUrl);
  if (recentlyWarmed.has(url)) return;
  recentlyWarmed.add(url);
  const download = fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Couldn't load audio (HTTP ${r.status})`);
    return r.arrayBuffer();
  });
  warm.set(url, download);
  download.catch(() => {
    warm.delete(url);
    recentlyWarmed.delete(url);
  });
  setTimeout(() => {
    warm.delete(url);
    recentlyWarmed.delete(url);
  }, WARM_TTL_MS);
}
