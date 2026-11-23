import { describe, expect, it } from "vitest";
import {
  addCaption, captionAt, captionsForSegments, captionsFromWords, CAPTION_TEMPLATES, emptyCaptionTrack, mergeCaptions,
  retimeCaption, sanitizeCaptionStyle, sanitizeCaptionTrack, setCaptionText, splitCaption, toEditedCaptions, toSrt, toVtt,
  type Caption,
} from "@/lib/studio/captions";
import { keptSegments, mergeRanges } from "@/lib/media/edl";
import type { StoredEdl } from "@/drizzle/schema";

const w = (text: string, start: number, end: number) => ({ text, start, end });
const WORDS = [
  w("Hello", 1.0, 1.5), w("world.", 1.5, 2.5),
  w("Second", 4.0, 4.6), w("caption", 4.6, 5.2), w("here.", 5.2, 6.0),
  w("Final", 8.2, 8.8), w("words", 8.8, 9.6),
];

describe("captionsFromWords", () => {
  it("breaks at sentence ends, long pauses and the word limit", () => {
    const cs = captionsFromWords(WORDS);
    expect(cs.map((c) => c.text)).toEqual(["Hello world.", "Second caption here.", "Final words"]);
    expect(cs[0]).toMatchObject({ start: 1.0, end: 2.5 });
    expect(cs[2].words).toHaveLength(2);
    const short = captionsFromWords(WORDS, { maxWords: 2 });
    expect(short.map((c) => c.text)).toEqual(["Hello world.", "Second caption", "here.", "Final words"]);
  });

  it("caps a caption's length in seconds", () => {
    const slow = Array.from({ length: 6 }, (_, i) => w(`w${i}`, i * 1.0, i * 1.0 + 0.9));
    const cs = captionsFromWords(slow, { maxSeconds: 3, maxGap: 5 });
    for (const c of cs) expect(c.end - c.start).toBeLessThanOrEqual(3);
  });

  it("produces nothing from no words", () => {
    expect(captionsFromWords([])).toEqual([]);
  });
});

describe("caption editing", () => {
  const [c] = captionsFromWords(WORDS.slice(2, 5));

  it("keeps word timings when the word count is unchanged", () => {
    const e = setCaptionText(c, "Second captions there.");
    expect(e.words!.map((x) => [x.text, x.start])).toEqual([["Second", 4.0], ["captions", 4.6], ["there.", 5.2]]);
  });

  it("spreads new words across the caption when the count changes", () => {
    const e = setCaptionText(c, "One two");
    expect(e.words).toHaveLength(2);
    expect(e.words![0].start).toBe(c.start);
    expect(e.words![1].end).toBeCloseTo(c.end, 6);
  });

  it("strips control and bidi-override characters", () => {
    expect(setCaptionText(c, "a\u0000b‮c\n d").text).toBe("a b c d");
  });

  it("splits at a word and merges back", () => {
    const [a, b] = splitCaption(c, 1)!;
    expect(a.text).toBe("Second");
    expect(b.text).toBe("caption here.");
    expect(a.end).toBe(4.6);
    expect(b.start).toBe(4.6);
    const m = mergeCaptions(a, b);
    expect(m.text).toBe(c.text);
    expect([m.start, m.end]).toEqual([c.start, c.end]);
    expect(splitCaption({ ...c, text: "one", words: [w("one", 4, 5)] })).toBeNull();
  });

  it("retimes without overlapping neighbours", () => {
    const cs = captionsFromWords(WORDS);
    const r = retimeCaption(cs, cs[1].id, 2.0, 7.0, 10);
    const mid = r.find((x) => x.id === cs[1].id)!;
    expect(mid.start).toBe(2.5); // previous caption ends at 2.5
    expect(mid.end).toBe(7.0);
    const r2 = retimeCaption(cs, cs[1].id, 4, 9.0, 10);
    expect(r2.find((x) => x.id === cs[1].id)!.end).toBe(8.2); // next starts at 8.2
  });

  it("adds a caption only into free time", () => {
    const cs = captionsFromWords(WORDS);
    expect(addCaption(cs, 1.2, 10)).toBe(cs); // occupied
    const added = addCaption(cs, 6.5, 10, "Hi there");
    expect(added).toHaveLength(4);
    const n = added.find((x) => x.text === "Hi there")!;
    expect([n.start, n.end]).toEqual([6.5, 8.2]);
  });
});

describe("captions on the edited timeline", () => {
  const cs = captionsFromWords(WORDS);

  it("shift earlier after a removed pause", () => {
    const merged = mergeRanges([{ start: 2.5, end: 4.0 }], 10);
    const e = toEditedCaptions(cs, merged);
    expect(e[1].start).toBeCloseTo(2.5, 6);
    expect(e[1].end).toBeCloseTo(4.5, 6);
    expect(e[1].words![0].start).toBeCloseTo(2.5, 6);
    expect(e[2].start).toBeCloseTo(6.7, 6);
  });

  it("drop words that were cut, and captions with nothing left", () => {
    // Cut "caption" (4.6–5.2) and the whole first sentence.
    const merged = mergeRanges([{ start: 4.6, end: 5.2 }, { start: 0.9, end: 2.6 }], 10);
    const e = toEditedCaptions(cs, merged);
    expect(e.map((c) => c.text)).toEqual(["Second here.", "Final words"]);
    expect(e[0].words!.map((x) => x.text)).toEqual(["Second", "here."]);
  });

  it("come back when the cut is undone (source captions are never rewritten)", () => {
    const merged = mergeRanges([{ start: 0.9, end: 2.6 }], 10);
    expect(toEditedCaptions(cs, merged)).toHaveLength(2);
    expect(toEditedCaptions(cs, [])).toHaveLength(3);
  });

  it("never overlap after mapping", () => {
    const merged = mergeRanges([{ start: 2.0, end: 4.3 }], 10);
    const e = toEditedCaptions(cs, merged);
    for (let i = 1; i < e.length; i++) expect(e[i].start).toBeGreaterThanOrEqual(e[i - 1].end);
  });

  it("map onto a clip's own timeline", () => {
    const merged = mergeRanges([{ start: 2.5, end: 4.0 }], 10);
    const kept = keptSegments(merged, 10);
    // Whole edit: same as toEditedCaptions.
    expect(captionsForSegments(cs, kept).map((c) => c.start)).toEqual(toEditedCaptions(cs, merged).map((c) => c.start));
    // A clip of source 4.0–6.0 starts at zero.
    const clip = captionsForSegments(cs, [{ start: 4.0, end: 6.0 }]);
    expect(clip).toHaveLength(1);
    expect(clip[0].start).toBeCloseTo(0, 6);
    expect(clip[0].end).toBeCloseTo(2, 6);
  });

  it("captionAt finds the caption on screen", () => {
    const e = toEditedCaptions(cs, []);
    expect(captionAt(e, 1.2)?.text).toBe("Hello world.");
    expect(captionAt(e, 3.0)).toBeNull();
    expect(captionAt(e, 9.59)?.text).toBe("Final words");
    expect(captionAt(e, 9.6)).toBeNull();
  });
});

describe("subtitle files", () => {
  const cs: Caption[] = [
    { id: "a", start: 0, end: 1.5, text: "First line" },
    { id: "b", start: 61.25, end: 3725.004, text: "<b>bold</b> & --> arrow" },
  ];

  it("writes SRT with comma milliseconds and 1-based cues", () => {
    expect(toSrt(cs)).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nFirst line\n\n2\n00:01:01,250 --> 01:02:05,004\n<b>bold</b> & --> arrow\n"
    );
  });

  it("writes WebVTT with dot milliseconds and escaped cue text", () => {
    const vtt = toVtt(cs);
    expect(vtt.startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nFirst line\n")).toBe(true);
    expect(vtt).toContain("01:01.250".padStart(12, "00:"));
    expect(vtt).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; --&gt; arrow");
    // Exactly one arrow per cue: cue text can't fake a timing line.
    expect(vtt.match(/-->/g)).toHaveLength(2);
  });
});

describe("validation and stored projects", () => {
  it("clamps style values and rejects unknown ones", () => {
    const s = sanitizeCaptionStyle({ size: 9, color: "red", font: "comic", animation: "explode", x: -1, maxLines: 99, weight: 500 });
    const d = CAPTION_TEMPLATES[0].style;
    expect(s.size).toBe(0.16);
    expect(s.color).toBe(d.color);
    expect(s.font).toBe(d.font);
    expect(s.animation).toBe(d.animation);
    expect(s.x).toBe(0);
    expect(s.maxLines).toBe(4);
    expect(s.weight).toBe(d.weight);
  });

  it("sanitizes an untrusted track without throwing", () => {
    for (const bad of [null, 1, "x", [], { captions: "no" }, { captions: [null, 1, { start: "a" }] }]) {
      const t = sanitizeCaptionTrack(bad, 10);
      expect(t.captions).toEqual([]);
      expect(t.version).toBe(1);
    }
    const t = sanitizeCaptionTrack({
      burnIn: false,
      captions: [
        { id: "ok", start: 5, end: 99, text: "late", words: [{ text: "late", start: 5, end: 99 }, { text: "", start: 1, end: 2 }] },
        { id: "<script>", start: 1, end: 2, text: "x".repeat(1000) },
        { start: 3, end: 3, text: "zero length" },
      ],
    }, 10);
    expect(t.burnIn).toBe(false);
    expect(t.captions).toHaveLength(2);
    expect(t.captions[0].text).toHaveLength(300); // sorted by start; capped
    expect(t.captions[0].id).not.toBe("<script>");
    expect(t.captions[1]).toMatchObject({ id: "ok", end: 10, words: [{ text: "late", start: 5, end: 10 }] });
  });

  it("round-trips through JSON (how it's stored in videos.edl)", () => {
    const track = { ...emptyCaptionTrack(), captions: captionsFromWords(WORDS) };
    const back = sanitizeCaptionTrack(JSON.parse(JSON.stringify(track)), 10);
    expect(back).toEqual(track);
  });

  it("loads edits saved before captions existed", () => {
    const old: StoredEdl = { version: 1, cuts: [{ start: 1, end: 2, reason: "manual" }], pauseLevel: null };
    const parsed = JSON.parse(JSON.stringify(old)) as StoredEdl;
    expect(parsed.captions).toBeUndefined();
    expect(sanitizeCaptionTrack(parsed.captions, 10).captions).toEqual([]);
  });
});
