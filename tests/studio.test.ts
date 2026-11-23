import { describe, expect, it } from "vitest";
import { WavWriter } from "@/lib/studio/wav";
import { docHistoryReducer, initialDocHistory, type EditDoc } from "@/lib/studio/doc";
import { defaultFx, untouchedFx } from "@/lib/studio/fx";
import { MERGE_WINDOW_MS } from "@/lib/media/history";

describe("WavWriter", () => {
  it("writes a valid 16-bit stereo PCM header and interleaved samples", () => {
    const w = new WavWriter(48000, 2);
    w.push(Float32Array.from([0, 1, -1]), Float32Array.from([0.5, -0.5, 2]));
    const buf = w.finish();
    const v = new DataView(buf);
    const ascii = (o: number, n: number) => String.fromCharCode(...new Uint8Array(buf, o, n));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(2); // channels
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(3 * 2 * 2); // data bytes
    expect(buf.byteLength).toBe(44 + 12);
    const samples = Array.from(new Int16Array(buf, 44));
    // L0 R0 L1 R1 L2 R2, clamped to full scale
    expect(samples).toEqual([0, 16384, 32767, -16384, -32768, 32767]);
  });

  it("reports its duration", () => {
    const w = new WavWriter(44100, 2);
    w.push(new Float32Array(44100), new Float32Array(44100));
    expect(w.durationSeconds).toBe(1);
  });
});

describe("editor history (cuts + audio settings)", () => {
  const start: EditDoc = { cuts: [], fx: untouchedFx() };
  const withGain = (db: number): EditDoc => ({ cuts: [], fx: { ...defaultFx(), inputGainDb: db } });

  it("collapses one slider drag into a single undo step", () => {
    let h = initialDocHistory(start);
    for (let i = 1; i <= 20; i++) h = docHistoryReducer(h, { type: "commit", value: withGain(i * 0.5), mergeKey: "fx:in", at: i * 16 });
    expect(h.past).toHaveLength(1);
    expect(h.present.fx.inputGainDb).toBe(10);
    h = docHistoryReducer(h, { type: "undo" });
    expect(h.present).toEqual(start);
  });

  it("starts a new step for a different control, or after a pause", () => {
    let h = initialDocHistory(start);
    h = docHistoryReducer(h, { type: "commit", value: withGain(1), mergeKey: "fx:in", at: 0 });
    h = docHistoryReducer(h, { type: "commit", value: withGain(2), mergeKey: "fx:out", at: 10 });
    expect(h.past).toHaveLength(2);
    h = docHistoryReducer(h, { type: "commit", value: withGain(3), mergeKey: "fx:out", at: 10 + MERGE_WINDOW_MS + 1 });
    expect(h.past).toHaveLength(3);
  });

  it("undoes cuts and audio changes in the order they were made", () => {
    let h = initialDocHistory(start);
    const cut = { start: 1, end: 2, reason: "manual" as const };
    h = docHistoryReducer(h, { type: "commit", value: { ...h.present, cuts: [cut] } });
    h = docHistoryReducer(h, { type: "commit", value: { ...h.present, fx: { ...defaultFx(), outputGainDb: 3 } }, mergeKey: "fx:o", at: 1 });
    h = docHistoryReducer(h, { type: "undo" });
    expect(h.present.cuts).toEqual([cut]);
    expect(h.present.fx).toEqual(untouchedFx());
    h = docHistoryReducer(h, { type: "undo" });
    expect(h.present).toEqual(start);
    h = docHistoryReducer(h, { type: "redo" });
    expect(h.present.cuts).toEqual([cut]);
  });

  it("ignores a commit that changes nothing", () => {
    const h = initialDocHistory(start);
    expect(docHistoryReducer(h, { type: "commit", value: { cuts: [], fx: untouchedFx() } })).toBe(h);
  });
});
