/// <reference lib="webworker" />
// Whisper speech-to-text with word timestamps, entirely in the browser.
//
// Runs in a dedicated worker so a multi-second inference never blocks the UI,
// and so cancelling is a hard `worker.terminate()` rather than a polite flag.
//
// Models (both 8-bit quantized, WASM, browser-cached after the first use):
//   - English: Xenova/whisper-tiny.en (~41 MB), the configuration verified
//     to emit word timestamps. (The onnx-community export of the same model
//     lacks cross-attention outputs and cannot produce them.)
//   - Hindi, Sanskrit, Hinglish, auto-detect: Xenova/whisper-small (~250 MB),
//     multilingual, also with word timestamps.
// Both are MIT-licensed OpenAI Whisper weights, served free by Hugging Face.
//
// Audio arrives pre-split into windows at pause boundaries
// (planTranscriptionWindows), so each Whisper call sees ≤ 28 s — under its
// 30 s context — no word is split between calls, and progress is real.
//
// Languages (see lib/media/language.ts for what was measured and why):
//   - transformers.js has no language detection: without a language it
//     silently decodes as English, which TRANSLATES Hindi speech. Detection
//     here is Whisper's own first decoder step, restricted to English/Hindi.
//   - Sanskrit decodes with the Hindi token (Devanagari); Whisper's Sanskrit
//     token writes romanized Latin.
//   - Hinglish: each window decodes as Hindi for context; phrases detected
//     as English are decoded again in English and spliced in by timestamp.

import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import type { Word } from "./align";
import type { Range } from "./edl";
import { modelFor, type SpokenLanguage, type TranscriptLanguage } from "./language";
import { transcribeWindows } from "./transcribeCore";

export type TranscribeRequest = {
  type: "transcribe";
  audio: Float32Array;
  sampleRate: number;
  windows: Range[];
  language: TranscriptLanguage;
};

export type TranscribeEvent =
  | { type: "model"; file: string; loaded: number; total: number }
  | { type: "ready"; loadMs: number; model: string }
  | { type: "window"; index: number; total: number; words: Word[]; language: SpokenLanguage }
  | { type: "done"; words: Word[]; inferenceMs: number; languages: Partial<Record<SpokenLanguage, number>> }
  | { type: "error"; message: string };

const loaded = new Map<string, AutomaticSpeechRecognitionPipeline>();
const post = (e: TranscribeEvent) => (self as unknown as Worker).postMessage(e);

async function load(model: string) {
  const existing = loaded.get(model);
  if (existing) return existing;
  const t0 = performance.now();
  const asr = (await pipeline("automatic-speech-recognition", model, {
    dtype: "q8",
    device: "wasm",
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status === "progress" && p.file) post({ type: "model", file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
    },
  })) as AutomaticSpeechRecognitionPipeline;
  loaded.set(model, asr);
  post({ type: "ready", loadMs: performance.now() - t0, model });
  return asr;
}

self.onmessage = async (msg: MessageEvent<TranscribeRequest>) => {
  if (msg.data.type !== "transcribe") return;
  const { audio, sampleRate, windows } = msg.data;
  const language: TranscriptLanguage = msg.data.language ?? "en";
  try {
    const asr = await load(modelFor(language).id);
    const t1 = performance.now();
    const { words, languages } = await transcribeWindows(asr, audio, sampleRate, windows, language, (index, w, spoken) =>
      post({ type: "window", index, total: windows.length, words: w, language: spoken }));
    post({ type: "done", words, inferenceMs: performance.now() - t1, languages });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
