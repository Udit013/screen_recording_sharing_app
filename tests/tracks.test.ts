import { describe, expect, it } from "vitest";
import {
  addClip, addTrack, audioUrlRule, clipEnd, clipGainAt, emptyMix, freeSlot, isPlainMix, mixInto, moveClip, removeClip,
  sanitizeMix, splitClip, trimClip, updateClip, updateTrack, type AudioMix, type DecodedClip,
} from "@/lib/studio/tracks";

const URL1 = "https://res.cloudinary.com/demo/video/upload/v1/snapcast/audio/vid-1/a1.mp3";
const asset = (duration: number, url = URL1) => ({ url, name: "song.mp3", duration });

function withTrack(): { m: AudioMix; tid: string } {
  const m = addTrack(emptyMix(), "music");
  return { m, tid: m.tracks[0].id };
}

describe("tracks and clips", () => {
  it("adds tracks with sensible defaults and a cap", () => {
    let m = addTrack(emptyMix(), "music");
    m = addTrack(m, "voice");
    m = addTrack(m, "music");
    expect(m.tracks.map((t) => [t.name, t.gainDb])).toEqual([["Music", -14], ["Voiceover", 0], ["Music 2", -14]]);
    for (let i = 0; i < 20; i++) m = addTrack(m, "sfx");
    expect(m.tracks).toHaveLength(8);
  });

  it("places clips in the first free slot and never overlaps", () => {
    const { m: m0, tid } = withTrack();
    let m = addClip(m0, tid, asset(10), 0);
    m = addClip(m, tid, asset(5), 3); // 0–10 is taken: goes to 10
    const cs = m.tracks[0].clips;
    expect(cs.map((c) => [c.start, clipEnd(c)])).toEqual([[0, 10], [10, 15]]);
    expect(freeSlot(m.tracks[0], 2, 1)).toBe(15);
  });

  it("moves a clip but stops at neighbours", () => {
    const { m: m0, tid } = withTrack();
    let m = addClip(m0, tid, asset(4), 0);
    m = addClip(m, tid, asset(4), 10);
    const second = m.tracks[0].clips[1].id;
    m = moveClip(m, second, 1); // would overlap the first clip
    expect(m.tracks[0].clips[1].start).toBe(4);
    m = moveClip(m, second, 30);
    expect(m.tracks[0].clips[1].start).toBe(30);
  });

  it("trims edges: left trim moves the in-point with it, bounded by the asset", () => {
    const { m: m0, tid } = withTrack();
    let m = addClip(m0, tid, asset(10), 5);
    const id = m.tracks[0].clips[0].id;
    m = trimClip(m, id, "left", 7);
    expect(m.tracks[0].clips[0]).toMatchObject({ start: 7, in: 2, out: 10 });
    m = trimClip(m, id, "left", 0); // can't reveal before the asset's start (5)
    expect(m.tracks[0].clips[0]).toMatchObject({ start: 5, in: 0 });
    m = trimClip(m, id, "right", 9);
    expect(m.tracks[0].clips[0]).toMatchObject({ out: 4 });
    m = trimClip(m, id, "right", 99); // can't extend past the asset
    expect(m.tracks[0].clips[0].out).toBe(10);
  });

  it("splits a clip into two back-to-back clips that play the same audio", () => {
    const { m: m0, tid } = withTrack();
    let m = addClip(m0, tid, asset(10), 2);
    const id = m.tracks[0].clips[0].id;
    m = splitClip(m, id, 6);
    const [a, b] = m.tracks[0].clips;
    expect([a.start, a.in, a.out, b.start, b.in, b.out]).toEqual([2, 0, 4, 6, 4, 10]);
    expect(a.fadeOutMs).toBe(0);
    expect(b.fadeInMs).toBe(0);
    expect(splitClip(m, a.id, 2.01)).toBe(m); // too close to an edge
    expect(removeClip(m, a.id).tracks[0].clips).toHaveLength(1);
  });

  it("knows when the mix is just the original audio", () => {
    const { m: m0, tid } = withTrack();
    expect(isPlainMix(m0)).toBe(true);
    const m = addClip(m0, tid, asset(3), 0);
    expect(isPlainMix(m)).toBe(false);
    expect(isPlainMix(updateTrack(m, tid, { muted: true }))).toBe(true);
    expect(isPlainMix({ ...emptyMix(), original: { muted: true, gainDb: 0 } })).toBe(false);
  });
});

describe("mixing", () => {
  const SR = 1000;
  const ramp = (n: number): DecodedClip => {
    const l = new Float32Array(n), r = new Float32Array(n);
    for (let i = 0; i < n; i++) { l[i] = 0.5; r[i] = -0.5; }
    return { left: l, right: r, from: 0, sampleRate: SR };
  };

  it("applies clip gain, fades and track gain", () => {
    const { m: m0, tid } = withTrack();
    let m = updateTrack(addClip(m0, tid, asset(2), 1), tid, { gainDb: 0 });
    const id = m.tracks[0].clips[0].id;
    m = updateClip(m, id, { gainDb: -6, fadeInMs: 500, fadeOutMs: 0 });
    const c = m.tracks[0].clips[0];
    expect(clipGainAt(c, 0.5)).toBe(0);
    expect(clipGainAt(c, 1.25)).toBeCloseTo(0.5 * Math.pow(10, -6 / 20), 6);
    expect(clipGainAt(c, 2)).toBeCloseTo(Math.pow(10, -6 / 20), 6);
    expect(clipGainAt(c, 3)).toBe(0); // end is exclusive
  });

  it("adds clips at the right samples, sums tracks and skips muted ones", () => {
    let m = addTrack(addTrack(emptyMix(), "music"), "sfx");
    const [t1, t2] = m.tracks.map((t) => t.id);
    m = updateTrack(updateTrack(m, t1, { gainDb: 0 }), t2, { gainDb: 0 });
    m = addClip(m, t1, asset(1), 0.5);
    m = addClip(m, t2, asset(1), 0.75);
    for (const t of m.tracks) for (const c of t.clips) { c.fadeInMs = 0; c.fadeOutMs = 0; }
    const decoded = new Map(m.tracks.flatMap((t) => t.clips.map((c) => [c.id, ramp(1000)] as const)));
    const L = new Float32Array(2000), R = new Float32Array(2000);
    mixInto(m, decoded, L, R, 2000, 0, SR);
    expect(L[499]).toBe(0);
    expect(L[500]).toBeCloseTo(0.5, 6);
    expect(L[800]).toBeCloseTo(1.0, 6); // both clips
    expect(R[800]).toBeCloseTo(-1.0, 6);
    expect(L[1499]).toBeCloseTo(1.0, 6); // both still playing
    expect(L[1500]).toBeCloseTo(0.5, 6); // first clip ends exactly at 1.5
    expect(L[1600]).toBeCloseTo(0.5, 6); // first ended at 1.5, second runs to 1.75
    expect(L[1750]).toBe(0);
    // Block boundaries don't change the result.
    const L2 = new Float32Array(2000), R2 = new Float32Array(2000);
    for (let s = 0; s < 2000; s += 128) {
      const n = Math.min(128, 2000 - s);
      mixInto(m, decoded, L2.subarray(s, s + n), R2.subarray(s, s + n), n, s / SR, SR);
    }
    let maxDiff = 0;
    for (let i = 0; i < 2000; i++) maxDiff = Math.max(maxDiff, Math.abs(L2[i] - L[i]));
    expect(maxDiff).toBeLessThan(1e-6);
    const muted = updateTrack(m, t2, { muted: true });
    const L3 = new Float32Array(2000), R3 = new Float32Array(2000);
    mixInto(muted, decoded, L3, R3, 2000, 0, SR);
    expect(L3[800]).toBeCloseTo(0.5, 6);
  });

  it("plays from the clip's in-point", () => {
    const { m: m0, tid } = withTrack();
    let m = updateTrack(addClip(m0, tid, asset(2), 0), tid, { gainDb: 0 });
    const id = m.tracks[0].clips[0].id;
    m = updateClip(trimClip(m, id, "left", 1), id, { fadeInMs: 0, fadeOutMs: 0 });
    const d: DecodedClip = { left: Float32Array.from({ length: 2000 }, (_, i) => i / 2000), right: new Float32Array(2000), from: 0, sampleRate: SR };
    const L = new Float32Array(1000), R = new Float32Array(1000);
    mixInto(m, new Map([[id, d]]), L, R, 1000, 1, SR);
    expect(L[0]).toBeCloseTo(0.5, 3); // asset time 1.0 at edited 1.0
    expect(L[500]).toBeCloseTo(0.75, 3);
  });
});

describe("validation", () => {
  const rule = audioUrlRule("demo", "vid-1");

  it("only allows this video's audio folder on our Cloudinary account", () => {
    expect(rule(URL1)).toBe(true);
    expect(rule("https://res.cloudinary.com/other/video/upload/v1/snapcast/audio/vid-1/a.mp3")).toBe(false);
    expect(rule("https://res.cloudinary.com/demo/video/upload/v1/snapcast/audio/vid-2/a.mp3")).toBe(false);
    expect(rule("https://evil.example/snapcast/audio/vid-1/a.mp3")).toBe(false);
    expect(rule(URL1 + '"><script>')).toBe(false);
  });

  it("sanitizes untrusted mixes without throwing", () => {
    for (const bad of [null, 1, "x", [], { tracks: "no" }, { tracks: [null, 3, { clips: [null, { url: 5 }] }] }]) {
      const m = sanitizeMix(bad, rule);
      expect(m.version).toBe(1);
      expect(m.tracks.every((t) => t.clips.length === 0)).toBe(true);
    }
    const m = sanitizeMix({
      original: { muted: true, gainDb: 99 },
      tracks: [{
        id: "t1", name: "x".repeat(500), kind: "weird", gainDb: -999,
        clips: [
          { id: "a", url: URL1, assetDuration: 10, start: 0, in: 2, out: 50, gainDb: 3 },
          { id: "b", url: URL1, assetDuration: 10, start: 4, in: 0, out: 5 }, // overlaps a (0–8): dropped
          { id: "c", url: "https://evil.example/a.mp3", assetDuration: 10, start: 20, in: 0, out: 5 },
          { id: "d", url: URL1, assetDuration: 10, start: 8, in: 0, out: 1 },
        ],
      }],
    }, rule);
    expect(m.original).toEqual({ muted: true, gainDb: 12 });
    const t = m.tracks[0];
    expect(t.kind).toBe("music");
    expect(t.name).toHaveLength(60);
    expect(t.gainDb).toBe(-60);
    expect(t.clips.map((c) => c.id)).toEqual(["a", "d"]);
    expect(t.clips[0]).toMatchObject({ in: 2, out: 10 });
  });

  it("round-trips through JSON", () => {
    const { m: m0, tid } = withTrack();
    const m = addClip(m0, tid, asset(10), 2);
    expect(sanitizeMix(JSON.parse(JSON.stringify(m)), rule)).toEqual(m);
  });
});
