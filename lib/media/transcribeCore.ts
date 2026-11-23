// The transcription logic shared by the browser worker (transcribe.worker.ts)
// and Node verification scripts: language detection, per-language decoding
// and the Hinglish phrase splice. It takes a loaded Whisper pipeline, so the
// same code runs wherever transformers.js does.

import { Tensor, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { wordsFromChunks, type Word } from "./align";
import type { Range } from "./edl";
import {
  decoderLanguage, languageRuns, pickLanguage, spliceWords, splitPhrases,
  type SpokenLanguage, type TranscriptLanguage,
} from "./language";

type Chunks = { chunks?: Array<{ text: string; timestamp: [number, number | null] }> };

/** Whisper's language prediction for a stretch of audio, restricted to English/Hindi. */
export async function detect(asr: AutomaticSpeechRecognitionPipeline, audio: Float32Array) {
  const gc = asr.model.generation_config as unknown as { decoder_start_token_id: number; lang_to_id: Record<string, number> };
  const { input_features } = await asr.processor(audio);
  // Build the tensor with the same Tensor class the model uses: with two
  // copies of transformers.js loaded (e.g. CJS + ESM in Node), a Tensor from
  // the other copy isn't recognised and the decoder input is dropped.
  const TensorCtor = (input_features as Tensor).constructor as typeof Tensor;
  const out = await asr.model({
    input_features,
    decoder_input_ids: new TensorCtor("int64", BigInt64Array.from([BigInt(gc.decoder_start_token_id)]), [1, 1]),
  });
  const logits = out.logits as Tensor;
  const data = logits.data as Float32Array;
  const vocab = logits.dims[logits.dims.length - 1];
  const base = data.length - vocab;
  const scores: Record<string, number> = {};
  for (const code of ["en", "hi"]) scores[code] = data[base + gc.lang_to_id[`<|${code}|>`]];
  return pickLanguage(scores);
}

export async function decode(asr: AutomaticSpeechRecognitionPipeline, audio: Float32Array, offset: number, lang: "en" | "hi" | null) {
  const opts: Record<string, unknown> = { return_timestamps: "word" };
  if (lang) { opts.language = lang; opts.task = "transcribe"; }
  const out = (await asr(audio, opts)) as Chunks;
  return wordsFromChunks(out.chunks ?? [], offset);
}

/**
 * Transcribes pause-aligned windows of 16 kHz mono audio in the chosen
 * language mode, calling `onWindow` as each one finishes. Returns every word
 * and the seconds of speech attributed to each language.
 */
export async function transcribeWindows(
  asr: AutomaticSpeechRecognitionPipeline,
  audio: Float32Array,
  sampleRate: number,
  windows: Range[],
  language: TranscriptLanguage,
  onWindow: (index: number, words: Word[], spoken: SpokenLanguage) => void = () => {}
) {
  const multilingual = language !== "en";
  const all: Word[] = [];
  const seconds: Partial<Record<SpokenLanguage, number>> = {};
    for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const slice = audio.subarray(Math.floor(w.start * sampleRate), Math.min(audio.length, Math.ceil(w.end * sampleRate)));
    let words: Word[];
    let spoken: SpokenLanguage;

    if (!multilingual) {
      spoken = "en";
      words = await decode(asr, slice, w.start, null);
    } else if (language === "hi" || language === "sa") {
      spoken = language;
      words = await decode(asr, slice, w.start, decoderLanguage(language));
    } else if (language === "auto") {
      spoken = (await detect(asr, slice)).language;
      words = await decode(asr, slice, w.start, decoderLanguage(spoken));
    } else {
      // Hinglish: Hindi decode for context, English phrases re-decoded.
      const phrases = splitPhrases(slice, sampleRate);
      const langs: SpokenLanguage[] = [];
      for (const p of phrases) {
        const a = slice.subarray(Math.floor(p.start * sampleRate), Math.ceil(p.end * sampleRate));
        const d = await detect(asr, a);
        langs.push(d.language === "en" && d.probability >= 0.6 ? "en" : "hi");
      }
      const runs = languageRuns(phrases, langs);
      const english = runs.filter((r) => r.language === "en");
      if (english.length === 0) {
        words = await decode(asr, slice, w.start, "hi");
      } else if (english.length === runs.length) {
        words = await decode(asr, slice, w.start, "en");
      } else {
        const hindi = await decode(asr, slice, w.start, "hi");
        const replaced: Word[] = [];
        for (const r of english) {
          // A little padding so the first/last syllables aren't clipped.
          const s = Math.max(0, r.range.start - 0.1), e = Math.min(slice.length / sampleRate, r.range.end + 0.1);
          const a = slice.subarray(Math.floor(s * sampleRate), Math.ceil(e * sampleRate));
          replaced.push(...(await decode(asr, a, w.start + s, "en")));
        }
        const abs = english.map((r) => ({ start: w.start + r.range.start - 0.1, end: w.start + r.range.end + 0.1 }));
        words = spliceWords(hindi, replaced, abs);
      }
      for (const r of runs) seconds[r.language] = (seconds[r.language] ?? 0) + (r.range.end - r.range.start);
      spoken = runs.length ? runs.reduce((a, b) => (b.range.end - b.range.start > a.range.end - a.range.start ? b : a)).language : "hi";
    }

    if (language !== "hinglish") seconds[spoken] = (seconds[spoken] ?? 0) + (w.end - w.start);
    all.push(...words);
    onWindow(i, words, spoken);
  }
  return { words: all, languages: seconds };
}
