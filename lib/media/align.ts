// Word-level transcript utilities: reconciling Whisper's word timestamps with
// the measured audio, grouping words into sentences, and turning a selection
// of words into a cut.

import { formatDuration } from "@/lib/utils";
import { roundMs, type Range } from "./edl";

export interface Word {
  text: string;
  start: number;
  end: number;
}

const MIN_WORD = 0.04;
const NOMINAL_WORD = 0.25;
/** A word starting this close to a pause's end is an early start of the next phrase. */
const FAR_SIDE_WINDOW = 0.2;
const EDGE_EPS = 0.001;

/**
 * Whisper derives word times from cross-attention alignment, which is only
 * approximately right, and errs in two measured ways (whisper-tiny.en on
 * synthetic speech with known pauses):
 *  - the last word before a pause absorbs the pause ("flow." 3.16→5.96 s while
 *    the audio went silent at 3.01 s);
 *  - times run late, typically 0.2–0.5 s ("Wait," at 23.78 s while speech
 *    resumed at 23.38 s).
 * Left alone, the first makes a kept word render as cut and "cut this word"
 * remove seconds of silence; the second makes cutting a sentence leave its
 * first syllable audible.
 *
 * Silence detection is measured directly from the waveform, so it wins any
 * disagreement:
 *  1. A word starting in speech is clipped to the end of that speech (the
 *     smear is always at the end).
 *  2. A word starting inside a pause belongs before it, unless it starts in the
 *     pause's last FAR_SIDE_WINDOW seconds, then it is an early start of what
 *     follows. Given the late bias, "before" is the safe default.
 *  3. Words stay ordered and disjoint.
 *  4. Word edges next to a pause snap to it: the first word after a pause
 *     starts where speech resumes, the last word before it ends where speech
 *     stopped.
 */
export function refineWords(words: Word[], silences: Range[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    let start = w.start;
    let end = Math.max(w.end, w.start);
    const len = Math.min(NOMINAL_WORD, Math.max(MIN_WORD, end - start));
    const host = silences.find((s) => start >= s.start && start < s.end);

    if (!host) {
      const stop = silences.find((s) => s.start > start && s.start < end);
      if (stop) end = stop.start;
    } else if (host.end - start <= FAR_SIDE_WINDOW) {
      start = host.end;
      const stop = silences.find((s) => s.start > start && s.start < end);
      end = Math.max(start + len, stop ? stop.start : end);
    } else {
      // Share the space with the previous word rather than swallowing it.
      const prev = out[out.length - 1];
      end = host.start;
      start = Math.max(host.start - len, prev && prev.start < host.start ? (prev.start + host.start) / 2 : -Infinity);
    }
    out.push({ text: w.text, start, end });
  }

  for (let i = 1; i < out.length; i++) {
    if (out[i].start < out[i - 1].start) out[i].start = out[i - 1].start;
    if (out[i - 1].end > out[i].start) out[i - 1].end = out[i].start;
  }

  // Snap edges to the pause between consecutive words, when there is one.
  let si = 0;
  for (let i = 0; i < out.length; i++) {
    const prevEnd = i > 0 ? out[i - 1].end : 0;
    while (si < silences.length && silences[si].end <= out[i].start + EDGE_EPS) si++;
    // silences[si - 1] is the last pause ending at or before this word.
    const gap = silences[si - 1];
    if (gap && gap.start >= prevEnd - EDGE_EPS) {
      out[i].start = Math.min(out[i].start, gap.end);
      if (i > 0) out[i - 1].end = Math.max(out[i - 1].end, gap.start);
    }
  }

  return out.map((w) => {
    const start = roundMs(Math.max(0, w.start));
    return { text: w.text, start, end: roundMs(Math.max(start, w.end)) };
  });
}

/** Normalizes Whisper word chunks: trims spacing, drops empties and NaNs. */
export function wordsFromChunks(
  chunks: Array<{ text: string; timestamp: [number, number | null] }>,
  offset = 0
): Word[] {
  const words: Word[] = [];
  for (const c of chunks) {
    const text = c.text.trim();
    const [s, e] = c.timestamp;
    // Whisper emits punctuation-only tokens ("...") with zero duration.
    if (!/[\p{L}\p{N}]/u.test(text) || !Number.isFinite(s)) continue;
    const start = s + offset;
    const end = (e != null && Number.isFinite(e) ? e : s) + offset;
    words.push({ text, start, end: Math.max(start, end) });
  }
  return words;
}

export interface Sentence {
  text: string;
  start: number;
  end: number;
  /** Index range into the words array, inclusive. */
  from: number;
  to: number;
}

/**
 * Groups words into sentences: a break after terminal punctuation, after a
 * long gap, or when a run gets too long to read as one line.
 */
export function groupSentences(
  words: Word[],
  { maxGap = 0.9, maxWords = 28 } = {}
): Sentence[] {
  const sentences: Sentence[] = [];
  let from = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const terminal = /[.!?]["')\]]?$/.test(w.text);
    const gap = next ? next.start - w.end : Infinity;
    if (!next || terminal || gap > maxGap || i - from + 1 >= maxWords) {
      const slice = words.slice(from, i + 1);
      sentences.push({
        text: slice.map((x) => x.text).join(" "),
        start: slice[0].start,
        end: slice[slice.length - 1].end,
        from,
        to: i,
      });
      from = i + 1;
    }
  }
  return sentences;
}

/**
 * The cut that removes words[from..to]. It runs from the first word's start to
 * the next kept word's start, so the gap that followed the removed words goes
 * with them — otherwise cutting a sentence would leave its pause behind as a
 * doubled silence. At the end of the transcript, the cut ends at the last
 * removed word.
 */
export function cutForWords(words: Word[], from: number, to: number): Range {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(words.length - 1, Math.max(from, to));
  const next = words[b + 1];
  return {
    start: roundMs(words[a].start),
    end: roundMs(next ? next.start : words[b].end),
  };
}

/** Converts words into the transcript segments the existing UI and search use. */
export function sentencesToTranscriptEntries(sentences: Sentence[]): TranscriptEntry[] {
  return sentences.map((s) => ({
    time: formatDuration(Math.floor(s.start)) || "0:00",
    text: s.text,
  }));
}

/** Words whose midpoint lies inside removed material. */
export function wordCutMask(words: Word[], merged: Range[]): boolean[] {
  return words.map((w) => {
    const mid = (w.start + w.end) / 2;
    return merged.some((c) => mid >= c.start && mid < c.end);
  });
}

const FILLERS = new Set(["um", "uh", "erm", "er", "uhm", "hmm", "mm"]);

/**
 * Filler words, best-effort. Whisper is trained on cleaned transcripts and
 * often omits disfluencies entirely, so absence here does not mean absence in
 * the audio — pause removal is the reliable tightening tool.
 */
export function isFiller(word: Word): boolean {
  return FILLERS.has(word.text.toLowerCase().replace(/[^a-z]/g, ""));
}
