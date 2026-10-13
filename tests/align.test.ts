import { describe, it, expect } from "vitest";
import {
  refineWords,
  wordsFromChunks,
  groupSentences,
  cutForWords,
  wordCutMask,
  sentencesToTranscriptEntries,
  isFiller,
  type Word,
} from "@/lib/media/align";
import { mergeRanges } from "@/lib/media/edl";

const w = (text: string, start: number, end: number): Word => ({ text, start, end });

describe("refineWords", () => {
  // Reproduces the measured Whisper behaviour on synthetic speech: the word
  // before a pause absorbs the pause.
  const silences = [{ start: 3.06, end: 5.96 }];

  it("pulls a word that swallowed a pause back to the speech before it", () => {
    const out = refineWords([w("deploy", 2.56, 3.0), w("flow.", 3.16, 5.96), w("First,", 6.42, 6.56)], silences);
    expect(out[1].end).toBeLessThanOrEqual(3.06);
    expect(out[1].start).toBeGreaterThan(2.5);
    // The next phrase starts where speech resumes, not where Whisper put it.
    expect(out[2]).toEqual(w("First,", 5.96, 6.56));
  });

  it("trims only the overlapping part of a word that runs into a pause", () => {
    const out = refineWords([w("hello", 2.5, 4.0)], silences);
    expect(out[0]).toEqual(w("hello", 2.5, 3.06));
  });

  it("moves a word to the far side only when it starts just before speech resumes", () => {
    expect(refineWords([w("later", 5.8, 5.9)], silences)[0].start).toBe(5.96);
    // Whisper runs late, so a start mid-pause belongs to the speech before it.
    const out = refineWords([w("one", 2.6, 2.9), w("two", 4.0, 4.4)], silences);
    expect(out[1].end).toBe(3.06);
    expect(out[0].end).toBeLessThanOrEqual(out[1].start);
  });

  it("drops punctuation-only tokens", () => {
    expect(wordsFromChunks([{ text: " ...", timestamp: [1, 1] }, { text: "ok", timestamp: [1, 1.2] }])).toEqual([w("ok", 1, 1.2)]);
  });

  // Real whisper-tiny.en output (q8) on a synthetic walkthrough with pauses,
  // and the silences detected from the same audio. Whisper runs 0.2–0.5 s late
  // and lets sentence-final words leak into the following pause.
  describe("on measured Whisper output", () => {
    const detected = [
      [3.5, 6.38], [9.3, 11.32], [11.92, 13.22], [14.52, 17.86],
      [21.52, 23.38], [25.54, 26.74], [28.68, 31.16], [31.66, 32.22],
    ].map(([start, end]) => ({ start, end }));
    const raw: Word[] = ([
      ["new", 2.7, 3.02], ["deploy", 3.02, 3.66], ["flow.", 3.66, 4.0], ["First,", 6.92, 7.2],
      ["project.", 9.36, 9.4], ["Umm", 12.2, 13.34], ["Then", 13.8, 14.0], ["deploy.", 14.42, 15.0],
      ["The", 18.08, 18.32], ["minute.", 21.44, 22.0], ["Wait,", 23.78, 23.96], ["that", 25.08, 25.5],
      ["sentence.", 25.5, 26.0], ["The", 26.92, 27.24], ["a", 28.44, 28.66], ["minute.", 28.66, 29.14],
      ["That's", 31.44, 31.96], ["it.", 31.96, 32.28], ["Thanks", 32.46, 32.62],
    ] as const).map(([t, a, b]) => w(t, a, b));
    const out = refineWords(raw, detected);

    it("leaves no word overlapping a pause", () => {
      for (const word of out) {
        for (const s of detected) {
          expect(word.end <= s.start + 1e-9 || word.start >= s.end - 1e-9, `${word.text} vs ${s.start}`).toBe(true);
        }
      }
    });

    it("starts each phrase where speech resumes", () => {
      const starts = Object.fromEntries(out.map((x, i) => [`${x.text}@${i}`, x.start]));
      expect(starts["First,@3"]).toBe(6.38);
      expect(starts["Wait,@10"]).toBe(23.38);
      expect(starts["The@13"]).toBe(26.74);
      expect(starts["Thanks@18"]).toBe(32.22);
    });

    it("keeps sentence-final words before the pause they leaked into", () => {
      expect(out[12]).toEqual(w("sentence.", 25.5, 25.54));
      expect(out[15].end).toBe(28.68);
      expect(out[5]).toEqual(w("Umm", 11.32, 11.92));
      expect(out[17].end).toBe(31.66);
    });

    it("never marks a kept word as cut by the pause cuts", () => {
      const cuts = mergeRanges(detected.map((s) => ({ start: s.start + 0.2, end: s.end - 0.2 })), 40);
      expect(wordCutMask(out, cuts).some(Boolean)).toBe(false);
    });
  });

  it("keeps words ordered and non-overlapping", () => {
    const out = refineWords([w("a", 1, 2.2), w("b", 2.0, 2.5), w("c", 2.4, 3.0)], []);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].start).toBeGreaterThanOrEqual(out[i - 1].end);
      expect(out[i].end).toBeGreaterThanOrEqual(out[i].start);
    }
  });

  it("is a no-op with no silences and clean input", () => {
    const words = [w("a", 0, 0.3), w("b", 0.4, 0.7)];
    expect(refineWords(words, [])).toEqual(words);
  });
});

describe("wordsFromChunks", () => {
  it("trims text, applies window offsets, and drops empty or broken chunks", () => {
    const out = wordsFromChunks([
      { text: " Hello,", timestamp: [0.5, 0.8] },
      { text: "  ", timestamp: [0.8, 0.9] },
      { text: "world", timestamp: [1.0, null] },
      { text: "bad", timestamp: [NaN, 1] },
    ], 10);
    expect(out).toEqual([w("Hello,", 10.5, 10.8), w("world", 11, 11)]);
  });
});

describe("groupSentences", () => {
  const words = [
    w("Hello,", 0, 0.3), w("this", 0.4, 0.6), w("works.", 0.7, 1),
    w("Next", 1.2, 1.4), w("part", 1.5, 1.7),
    w("after", 3.5, 3.8), w("pause", 3.9, 4.2),
  ];

  it("breaks on terminal punctuation and on long gaps", () => {
    expect(groupSentences(words).map((s) => s.text)).toEqual([
      "Hello, this works.", "Next part", "after pause",
    ]);
  });

  it("records word index ranges", () => {
    const s = groupSentences(words);
    expect(s.map((x) => [x.from, x.to])).toEqual([[0, 2], [3, 4], [5, 6]]);
  });

  it("produces transcript entries the existing UI understands", () => {
    expect(sentencesToTranscriptEntries(groupSentences(words))[2]).toEqual({ time: "0:03", text: "after pause" });
  });
});

describe("cutForWords", () => {
  const words = [w("keep", 0, 0.5), w("drop", 1, 1.4), w("this", 1.5, 1.8), w("next", 3, 3.4)];

  it("cuts through to the next kept word so no doubled pause remains", () => {
    expect(cutForWords(words, 1, 2)).toEqual({ start: 1, end: 3 });
  });

  it("accepts a reversed selection", () => {
    expect(cutForWords(words, 2, 1)).toEqual({ start: 1, end: 3 });
  });

  it("ends at the last word when cutting through the end", () => {
    expect(cutForWords(words, 2, 3)).toEqual({ start: 1.5, end: 3.4 });
  });
});

describe("wordCutMask", () => {
  it("marks words whose midpoint lies inside a cut", () => {
    const words = [w("a", 0, 1), w("b", 1, 2), w("c", 2, 3)];
    expect(wordCutMask(words, mergeRanges([{ start: 0.9, end: 2.1 }], 3))).toEqual([false, true, false]);
  });
});

it("isFiller recognises common disfluencies regardless of punctuation", () => {
  expect(isFiller(w("Um,", 0, 1))).toBe(true);
  expect(isFiller(w("uh", 0, 1))).toBe(true);
  expect(isFiller(w("under", 0, 1))).toBe(false);
});
