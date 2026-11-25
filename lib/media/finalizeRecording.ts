// Makes a MediaRecorder recording seekable.
//
// MediaRecorder writes WebM as a live stream: no duration in the header and
// no seek index (Cues). Players then show a seek bar that jumps and grows
// while playing and can't seek. Remuxing with mediabunny copies the encoded
// video and audio as-is (no re-encode, so it's quick and lossless) and writes
// a proper header with the duration and Cues. On any failure the original
// recording is returned unchanged.

import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Output, WebMOutputFormat } from "mediabunny";

export async function finalizeRecording(blob: Blob): Promise<Blob> {
  if (blob.size === 0) return blob;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    const conversion = await Conversion.init({ input, output });
    if (!conversion.isValid) return blob;
    await conversion.execute();
    const buffer = output.target.buffer;
    return buffer && buffer.byteLength > 0 ? new Blob([buffer], { type: "video/webm" }) : blob;
  } catch (err) {
    console.warn("Couldn't finalize the recording; keeping the original.", err);
    return blob;
  } finally {
    input.dispose();
  }
}
