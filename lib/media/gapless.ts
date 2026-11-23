// Gapless start trimming for decoded audio.
//
// MP3 decoders output extra samples at the start: the encoder's own delay
// (written in the LAME/Info tag of the first frame) plus 529 samples of
// decoder delay. Players that honour the tag (ffmpeg, browsers' <audio>)
// skip them; mediabunny's decoder doesn't, so audio decoded through it ran
// late (measured: a click at 1.000 s came out at 1.025 s, i.e. 576 + 529
// samples at 44.1 kHz). These helpers read the tag so callers can skip them.

const DECODER_DELAY = 529;

/**
 * Samples to drop from the start of a decoded MP3, from the first few KB of
 * the file. Returns encoder delay + decoder delay when a Xing/Info frame with
 * a LAME extension is present, the decoder delay alone otherwise, and null
 * for data that isn't MP3.
 */
export function mp3StartTrim(head: Uint8Array): number | null {
  // Skip an ID3v2 tag if the head starts with one.
  let start = 0;
  if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33 && head.length > 10) {
    start = 10 + ((head[6] & 0x7f) << 21 | (head[7] & 0x7f) << 14 | (head[8] & 0x7f) << 7 | (head[9] & 0x7f));
  }
  // First MPEG audio frame sync.
  let f = -1;
  for (let i = start; i + 1 < head.length; i++) if (head[i] === 0xff && (head[i + 1] & 0xe0) === 0xe0) { f = i; break; }
  if (f < 0) return null;
  const find = (s: string) => {
    for (let i = f; i + 4 <= Math.min(head.length, f + 200); i++) {
      if (head[i] === s.charCodeAt(0) && head[i + 1] === s.charCodeAt(1) && head[i + 2] === s.charCodeAt(2) && head[i + 3] === s.charCodeAt(3)) return i;
    }
    return -1;
  };
  const x = Math.max(find("Xing"), find("Info"));
  if (x < 0) return DECODER_DELAY;
  const flags = (head[x + 4] << 24) | (head[x + 5] << 16) | (head[x + 6] << 8) | head[x + 7];
  let o = x + 8;
  if (flags & 1) o += 4;   // frame count
  if (flags & 2) o += 4;   // byte count
  if (flags & 4) o += 100; // seek TOC
  if (flags & 8) o += 4;   // quality
  if (o + 24 > head.length) return DECODER_DELAY;
  // LAME extension: 9-byte encoder string, then delay/padding at +21 (12 bits each).
  const enc = String.fromCharCode(...head.subarray(o, o + 4));
  if (!/^(LAME|Lavc|Lavf|GOGO)/.test(enc)) return DECODER_DELAY;
  const delay = (head[o + 21] << 4) | (head[o + 22] >> 4);
  return delay + DECODER_DELAY;
}

/** First bytes of a Blob or URL (Range request), for mp3StartTrim. */
export async function readHead(src: Blob | string, bytes = 8192): Promise<Uint8Array> {
  if (typeof src !== "string") return new Uint8Array(await src.slice(0, bytes).arrayBuffer());
  const r = await fetch(src, { headers: { Range: `bytes=0-${bytes - 1}` } });
  const b = new Uint8Array(await r.arrayBuffer());
  return b.subarray(0, bytes);
}

/**
 * Wraps a decoded-chunk stream so it starts at the true beginning: frames
 * with negative timestamps (AAC priming that an edit list marks) and the
 * first `skipFrames` frames (MP3 delay) are dropped.
 */
export async function* trimStart<T extends { left: Float32Array; right: Float32Array; frames: number; timestamp: number }>(
  chunks: AsyncIterable<T>,
  sampleRate: number,
  skipFrames: number
): AsyncGenerator<T> {
  let toSkip = skipFrames;
  let out = 0;
  for await (const c of chunks) {
    let from = 0;
    if (c.timestamp < 0) from = Math.min(c.frames, Math.round(-c.timestamp * sampleRate));
    if (toSkip > 0) {
      const k = Math.min(c.frames - from, toSkip);
      from += k;
      toSkip -= k;
    }
    if (from >= c.frames) continue;
    const frames = c.frames - from;
    yield { ...c, left: c.left.subarray(from), right: c.right.subarray(from), frames, timestamp: out / sampleRate };
    out += frames;
  }
}
