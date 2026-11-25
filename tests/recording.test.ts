import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ALL_FORMATS, BlobSource, Input } from "mediabunny";
import { compositeSize } from "@/lib/hooks/useScreenRecording";
import { finalizeRecording } from "@/lib/media/finalizeRecording";

// Screen + camera recordings were stretched (a 16:10 Mac screen drawn into a
// fixed 16:9 canvas), and MediaRecorder's WebM had no duration or seek index,
// so the player's seek bar jumped around. These pin both fixes.

describe("composite canvas size", () => {
  it("keeps the screen's aspect ratio, caps the long side, uses even sizes", () => {
    expect(compositeSize(3024, 1964)).toEqual({ width: 1920, height: 1246 }); // MacBook Pro 14" (≈16:10)
    expect(compositeSize(1920, 1080)).toEqual({ width: 1920, height: 1080 });
    expect(compositeSize(1280, 800)).toEqual({ width: 1280, height: 800 }); // never upscaled
    expect(compositeSize(1080, 2340)).toEqual({ width: 886, height: 1920 }); // portrait
    const { width, height } = compositeSize(3456, 2234);
    expect(Math.abs(width / height - 3456 / 2234)).toBeLessThan(0.01);
    expect(compositeSize(0, 0)).toEqual({ width: 1920, height: 1080 });
  });
});

describe("finalizing a MediaRecorder recording", () => {
  // tests/fixtures/mediarecorder-like.webm: VP9 + Opus written as a live
  // stream (ffmpeg -live 1), i.e. no duration and no Cues, like MediaRecorder.
  const raw = new Blob([readFileSync("tests/fixtures/mediarecorder-like.webm")]);
  const hasCues = async (b: Blob) => Buffer.from(await b.arrayBuffer()).includes(Buffer.from("1C53BB6B", "hex"));

  it("writes the seek index without re-encoding", async () => {
    expect(await hasCues(raw)).toBe(false);
    const out = await finalizeRecording(raw);
    expect(await hasCues(out)).toBe(true);
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(out) });
    expect(await input.computeDuration()).toBeCloseTo(2, 0);
    expect((await input.getPrimaryVideoTrack())?.codec).toBe("vp9");
    expect((await input.getPrimaryAudioTrack())?.codec).toBe("opus");
    expect(Math.abs(out.size - raw.size) / raw.size).toBeLessThan(0.05); // copied, not re-encoded
  });

  it("returns the original when the input isn't a readable video", async () => {
    const junk = new Blob([new Uint8Array(100).fill(7)]);
    expect(await finalizeRecording(junk)).toBe(junk);
  });
});
