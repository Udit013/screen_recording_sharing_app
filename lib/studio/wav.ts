// A streaming 16-bit PCM WAV writer for audio-only exports. WAV needs no
// encoder (WebCodecs has none for it, and none is needed): it is a 44-byte
// header followed by interleaved samples.

export class WavWriter {
  private chunks: Int16Array[] = [];
  private frames = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly channels: 1 | 2 = 2
  ) {}

  /** Appends planar float samples (clamped to [-1, 1] and rounded). */
  push(left: Float32Array, right: Float32Array | null, frames = left.length): void {
    const out = new Int16Array(frames * this.channels);
    for (let i = 0; i < frames; i++) {
      out[i * this.channels] = toInt16(left[i]);
      if (this.channels === 2) out[i * 2 + 1] = toInt16((right ?? left)[i]);
    }
    this.chunks.push(out);
    this.frames += frames;
  }

  get durationSeconds(): number {
    return this.frames / this.sampleRate;
  }

  finish(): ArrayBuffer {
    const dataBytes = this.frames * this.channels * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const v = new DataView(buffer);
    const ascii = (offset: number, s: string) => {
      for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
    };
    ascii(0, "RIFF");
    v.setUint32(4, 36 + dataBytes, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    v.setUint32(16, 16, true); // fmt chunk size
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, this.channels, true);
    v.setUint32(24, this.sampleRate, true);
    v.setUint32(28, this.sampleRate * this.channels * 2, true); // byte rate
    v.setUint16(32, this.channels * 2, true); // block align
    v.setUint16(34, 16, true); // bits per sample
    ascii(36, "data");
    v.setUint32(40, dataBytes, true);
    let offset = 44;
    for (const c of this.chunks) {
      new Int16Array(buffer, offset, c.length).set(c);
      offset += c.byteLength;
    }
    this.chunks = [];
    return buffer;
  }
}

function toInt16(x: number): number {
  const c = x > 1 ? 1 : x < -1 ? -1 : x;
  return c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff);
}
