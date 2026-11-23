import { describe, expect, it } from "vitest";
import {
  decoderLanguage, languageRuns, modelFor, pickLanguage, scriptOf, scriptsMatch, spliceWords, splitPhrases,
} from "@/lib/media/language";
import { groupSentences, wordsFromChunks } from "@/lib/media/align";
import { captionsFromWords, toSrt, toVtt } from "@/lib/studio/captions";

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe("language choice", () => {
  it("picks among English and Hindi only, renormalised", () => {
    // Urdu would win outright; it's not a candidate, so Hindi is chosen.
    const r = pickLanguage({ en: -2, hi: 1, ur: 5 });
    expect(r.language).toBe("hi");
    expect(r.probability).toBeCloseTo(Math.exp(1) / (Math.exp(1) + Math.exp(-2)), 6);
    expect(pickLanguage({ en: 3, hi: 1 }).language).toBe("en");
    expect(pickLanguage({}).probability).toBe(0);
  });

  it("decodes Sanskrit with the Hindi token (Devanagari) and uses the English-only model for English", () => {
    expect(decoderLanguage("sa")).toBe("hi");
    expect(decoderLanguage("en")).toBe("en");
    expect(modelFor("en").id).toBe("Xenova/whisper-tiny.en");
    for (const l of ["hi", "sa", "auto", "hinglish"] as const) expect(modelFor(l).id).toBe("Xenova/whisper-small");
  });
});

describe("scripts", () => {
  it("classifies words by script", () => {
    expect(scriptOf("नमस्ते")).toBe("devanagari");
    expect(scriptOf("सर्वे,")).toBe("devanagari");
    expect(scriptOf("video")).toBe("latin");
    expect(scriptOf("café")).toBe("latin");
    expect(scriptOf("123।")).toBe("none");
    expect(scriptOf("سلام")).toBe("other");
  });

  it("checks a transcript is in the right script", () => {
    expect(scriptsMatch([w("आज", 0, 1), w("हम", 1, 2)], "hi")).toBe(true);
    expect(scriptsMatch([w("आज", 0, 1), w("AI", 1, 2)], "hi")).toBe(true); // acronym
    expect(scriptsMatch([w("aaj", 0, 1)], "hi")).toBe(false);
    expect(scriptsMatch([w("today", 0, 1)], "en")).toBe(true);
    expect(scriptsMatch([w("आज", 0, 1)], "en")).toBe(false);
  });
});

describe("phrases and splicing", () => {
  const SR = 16000;
  const tone = (parts: [number, boolean][]) => {
    const n = parts.reduce((s, [d]) => s + Math.round(d * SR), 0);
    const x = new Float32Array(n);
    let o = 0;
    for (const [d, on] of parts) {
      const k = Math.round(d * SR);
      for (let i = 0; i < k; i++) x[o + i] = on ? 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR) : 0.0005 * Math.sin(i);
      o += k;
    }
    return x;
  };

  it("splits at pauses and merges phrases too short to judge", () => {
    const x = tone([[1.0, true], [0.25, false], [1.2, true], [0.3, false], [0.3, true], [0.3, false]]);
    const p = splitPhrases(x, SR);
    expect(p).toHaveLength(2);
    expect(p[0].start).toBeCloseTo(0, 1);
    expect(p[0].end).toBeCloseTo(1.0, 1);
    expect(p[1].start).toBeCloseTo(1.25, 1);
    expect(p[1].end).toBeCloseTo(3.05, 1); // the 0.3 s blip (2.75–3.05) joined the previous phrase
  });

  it("returns the whole range for audio with no usable pauses", () => {
    expect(splitPhrases(tone([[2, true]]), SR)).toEqual([{ start: 0, end: 2 }]);
  });

  it("joins same-language phrases into runs", () => {
    const runs = languageRuns(
      [{ start: 0, end: 1 }, { start: 1.2, end: 2 }, { start: 2.3, end: 3 }, { start: 3.1, end: 4 }],
      ["hi", "hi", "en", "hi"]
    );
    expect(runs.map((r) => [r.language, r.range.start, r.range.end])).toEqual([["hi", 0, 2], ["en", 2.3, 3], ["hi", 3.1, 4]]);
  });

  it("replaces words inside English ranges with the English decode", () => {
    const hindi = [w("तो", 0, 0.3), w("अन", 2.1, 2.3), w("देन", 2.3, 2.6), w("बस", 4.2, 4.5)];
    const english = [w("and", 2.05, 2.25), w("then", 2.25, 2.6), w("stray", 5, 5.2)];
    const out = spliceWords(hindi, english, [{ start: 2.0, end: 4.0 }]);
    expect(out.map((x) => x.text)).toEqual(["तो", "and", "then", "बस"]);
  });
});

describe("Devanagari through the transcript and captions", () => {
  it("keeps the danda as a sentence end", () => {
    const words = wordsFromChunks([
      { text: " आज", timestamp: [0, 0.4] },
      { text: " हम", timestamp: [0.4, 0.8] },
      { text: "।", timestamp: [0.8, 0.8] },
      { text: " बस", timestamp: [2, 2.4] },
    ]);
    expect(words.map((x) => x.text)).toEqual(["आज", "हम।", "बस"]);
    expect(groupSentences(words).length).toBe(2);
  });

  it("breaks captions at the danda and writes UTF-8 subtitles intact", () => {
    const words = [w("नमस्ते", 0, 0.5), w("दोस्तों।", 0.5, 1), w("आज", 1.1, 1.4), w("हम", 1.4, 1.6)];
    const cs = captionsFromWords(words);
    expect(cs.map((c) => c.text)).toEqual(["नमस्ते दोस्तों।", "आज हम"]);
    expect(toSrt(cs)).toContain("नमस्ते दोस्तों।");
    expect(toVtt(cs)).toContain("आज हम");
  });

  it("keeps mixed-script captions as spoken", () => {
    const cs = captionsFromWords([w("तो", 0, 0.3), w("पहले", 0.3, 0.6), w("and", 0.7, 0.9), w("then", 0.9, 1.1)]);
    expect(cs[0].text).toBe("तो पहले and then");
    expect(cs[0].words!.map((x) => scriptOf(x.text))).toEqual(["devanagari", "devanagari", "latin", "latin"]);
  });
});
