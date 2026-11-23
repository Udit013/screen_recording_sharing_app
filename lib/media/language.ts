// Transcription languages: English, Hindi, Sanskrit and code-mixed Hinglish.
// Pure helpers shared by the transcription worker and the editor, unit-tested
// in tests/language.test.ts.
//
// What Whisper can and can't do here (measured with whisper-small, q8, on
// synthetic speech; see docs/STUDIO.md):
//   - English and Hindi are detected reliably (p ≥ 0.84 on every sample).
//   - Sanskrit is NOT detectable (a Sanskrit verse scored en 0.81, sa 0.01),
//     and decoding with Whisper's own Sanskrit token writes romanized Latin.
//     Decoding Sanskrit with the Hindi token gives Devanagari, so "Sanskrit"
//     means: Devanagari output via the Hindi decoder, chosen manually.
//   - Whisper decodes one language per call. Forced to Hindi, English words
//     come out transliterated into Devanagari ("which makes" → "विछ मेख्स").
//     Hinglish mode therefore detects the language of each phrase and
//     re-decodes English phrases in English, splicing them in by timestamp.
//     A switch with no pause at all can't be separated and stays one script.

import type { Word } from "./align";
import type { Range } from "./edl";

export type TranscriptLanguage = "auto" | "en" | "hi" | "sa" | "hinglish";
export type SpokenLanguage = "en" | "hi" | "sa";

export const LANGUAGE_OPTIONS: { id: TranscriptLanguage; label: string; hint: string }[] = [
  { id: "auto", label: "Auto-detect (English / Hindi)", hint: "Detects English or Hindi for each part of the recording." },
  { id: "en", label: "English", hint: "Fastest: a small English-only model (41 MB)." },
  { id: "hi", label: "Hindi (हिन्दी)", hint: "Devanagari script." },
  { id: "sa", label: "Sanskrit (संस्कृतम्)", hint: "Devanagari script. Spelling is phonetic; see the note below." },
  { id: "hinglish", label: "Hinglish (mixed Hindi + English)", hint: "Hindi in Devanagari, English in Latin, phrase by phrase." },
];

/** English uses the small English-only model; everything else the multilingual one. */
export const MODELS = {
  english: { id: "Xenova/whisper-tiny.en", approxMB: 41 },
  multilingual: { id: "Xenova/whisper-small", approxMB: 250 },
} as const;

export const modelFor = (lang: TranscriptLanguage) => (lang === "en" ? MODELS.english : MODELS.multilingual);

/** The Whisper language token to decode with (Sanskrit decodes as Hindi to get Devanagari). */
export const decoderLanguage = (spoken: SpokenLanguage): "en" | "hi" => (spoken === "en" ? "en" : "hi");

/** Languages auto-detection chooses between. Others (e.g. Urdu, which Hindi is often mistaken for) are excluded. */
export const DETECTABLE: SpokenLanguage[] = ["en", "hi"];

/**
 * Picks the most likely language from Whisper's language-token logits,
 * restricted to `candidates`. Returns the language and its probability
 * renormalised over the candidates.
 */
export function pickLanguage(logits: Partial<Record<string, number>>, candidates: SpokenLanguage[] = DETECTABLE) {
  const vals = candidates.map((c) => [c, logits[c] ?? -Infinity] as const);
  const max = Math.max(...vals.map(([, v]) => v));
  if (!Number.isFinite(max)) return { language: candidates[0], probability: 0 };
  const exps = vals.map(([c, v]) => [c, Math.exp(v - max)] as const);
  const z = exps.reduce((s, [, e]) => s + e, 0);
  const [best, e] = exps.reduce((a, b) => (b[1] > a[1] ? b : a));
  return { language: best, probability: e / z };
}

// ── Scripts ──────────────────────────────────────────────────────────────

export type Script = "devanagari" | "latin" | "other" | "none";

/** The dominant script of a word, ignoring digits and punctuation. */
export function scriptOf(text: string): Script {
  let dev = 0, lat = 0, other = 0;
  for (const ch of text) {
    if (/\p{Script=Devanagari}/u.test(ch)) dev++;
    else if (/\p{Script=Latin}/u.test(ch)) lat++;
    else if (/\p{L}/u.test(ch)) other++;
  }
  if (!dev && !lat && !other) return "none";
  return dev >= lat && dev >= other ? "devanagari" : lat >= other ? "latin" : "other";
}

export const hasDevanagari = (s: string) => /\p{Script=Devanagari}/u.test(s);

/** True when every word is in the script its language should use. */
export function scriptsMatch(words: Word[], spoken: SpokenLanguage): boolean {
  const want: Script = spoken === "en" ? "latin" : "devanagari";
  return words.every((w) => {
    const s = scriptOf(w.text);
    return s === "none" || s === want || (spoken !== "en" && s === "latin" && /^[A-Z0-9]{2,}$/.test(w.text)); // acronyms in Hindi speech
  });
}

// ── Phrases and splicing ─────────────────────────────────────────────────

/**
 * Splits audio into phrases at short pauses: RMS in 20 ms frames, a pause is
 * ≥ `minGap` seconds below a threshold placed 25% of the way from the noise
 * floor (10th percentile) to speech level (90th), in dB. Phrases shorter
 * than `minPhrase` merge into a neighbour. Times are relative to `samples`.
 */
export function splitPhrases(samples: Float32Array, sampleRate: number, minGap = 0.12, minPhrase = 0.6): Range[] {
  const hop = Math.round(0.02 * sampleRate);
  const n = Math.floor(samples.length / hop);
  if (n === 0) return [];
  const db = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) e += samples[i] * samples[i];
    db[f] = 10 * Math.log10(e / hop + 1e-12);
  }
  const sorted = Array.from(db).sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.1)], speech = sorted[Math.min(n - 1, Math.floor(n * 0.9))];
  const full = [{ start: 0, end: samples.length / sampleRate }];
  if (speech - floor < 10) return full;
  const thr = floor + 0.25 * (speech - floor);
  const gapFrames = Math.max(1, Math.round(minGap / 0.02));
  const phrases: Range[] = [];
  let start = -1, quiet = 0;
  for (let f = 0; f < n; f++) {
    if (db[f] >= thr) {
      if (start < 0) start = f;
      quiet = 0;
    } else if (start >= 0 && ++quiet >= gapFrames) {
      phrases.push({ start: start * 0.02, end: (f - quiet + 1) * 0.02 });
      start = -1; quiet = 0;
    }
  }
  if (start >= 0) phrases.push({ start: start * 0.02, end: n * 0.02 });
  if (phrases.length === 0) return full;
  // Merge phrases too short to judge their language alone.
  const merged: Range[] = [];
  for (const p of phrases) {
    const last = merged[merged.length - 1];
    if (last && (p.end - p.start < minPhrase || last.end - last.start < minPhrase)) last.end = p.end;
    else merged.push({ ...p });
  }
  return merged;
}

/** Consecutive phrases of the same language, joined into runs. */
export function languageRuns(phrases: Range[], langs: SpokenLanguage[]): { range: Range; language: SpokenLanguage }[] {
  const runs: { range: Range; language: SpokenLanguage }[] = [];
  phrases.forEach((p, i) => {
    const last = runs[runs.length - 1];
    if (last && last.language === langs[i]) last.range = { start: last.range.start, end: p.end };
    else runs.push({ range: { ...p }, language: langs[i] });
  });
  return runs;
}

/**
 * Replaces the words of `base` whose midpoint lies inside any of `ranges`
 * with `replacement` (words decoded separately for those ranges, e.g.
 * English phrases inside a Hindi decode). Keeps time order.
 */
export function spliceWords(base: Word[], replacement: Word[], ranges: Range[]): Word[] {
  const inside = (w: Word) => ranges.some((r) => (w.start + w.end) / 2 >= r.start && (w.start + w.end) / 2 < r.end);
  return [...base.filter((w) => !inside(w)), ...replacement.filter(inside)].sort((a, b) => a.start - b.start);
}
