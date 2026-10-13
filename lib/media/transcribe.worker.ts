/// <reference lib="webworker" />
// Whisper speech-to-text with word timestamps, entirely in the browser.
//
// Runs in a dedicated worker so a multi-second inference never blocks the UI,
// and so cancelling is a hard `worker.terminate()` rather than a polite flag.
//
// Model: Xenova/whisper-tiny.en, 8-bit quantized, WASM backend — the exact
// configuration verified to emit word timestamps. (The onnx-community export
// of the same model lacks cross-attention outputs and cannot produce them.)
// Weights (~40 MB) download once from Hugging Face and are browser-cached.
//
// Audio arrives pre-split into windows at pause boundaries
// (planTranscriptionWindows), so each Whisper call sees ≤ 28 s — under its
// 30 s context — no word is split between calls, and progress is real.

import { pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { wordsFromChunks, type Word } from "./align";
import type { Range } from "./edl";

export type TranscribeRequest = {
  type: "transcribe";
  audio: Float32Array;
  sampleRate: number;
  windows: Range[];
};

export type TranscribeEvent =
  | { type: "model"; file: string; loaded: number; total: number }
  | { type: "ready"; loadMs: number }
  | { type: "window"; index: number; total: number; words: Word[] }
  | { type: "done"; words: Word[]; inferenceMs: number }
  | { type: "error"; message: string };

const MODEL = "Xenova/whisper-tiny.en";
let asr: AutomaticSpeechRecognitionPipeline | null = null;

const post = (e: TranscribeEvent) => (self as unknown as Worker).postMessage(e);

self.onmessage = async (msg: MessageEvent<TranscribeRequest>) => {
  if (msg.data.type !== "transcribe") return;
  const { audio, sampleRate, windows } = msg.data;
  try {
    if (!asr) {
      const t0 = performance.now();
      asr = (await pipeline("automatic-speech-recognition", MODEL, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
          if (p.status === "progress" && p.file) {
            post({ type: "model", file: p.file, loaded: p.loaded ?? 0, total: p.total ?? 0 });
          }
        },
      })) as AutomaticSpeechRecognitionPipeline;
      post({ type: "ready", loadMs: performance.now() - t0 });
    }

    const all: Word[] = [];
    const t1 = performance.now();
    for (let i = 0; i < windows.length; i++) {
      const w = windows[i];
      const slice = audio.subarray(
        Math.floor(w.start * sampleRate),
        Math.min(audio.length, Math.ceil(w.end * sampleRate))
      );
      const out = (await asr(slice, { return_timestamps: "word" })) as {
        chunks?: Array<{ text: string; timestamp: [number, number | null] }>;
      };
      const words = wordsFromChunks(out.chunks ?? [], w.start);
      all.push(...words);
      post({ type: "window", index: i, total: windows.length, words });
    }
    post({ type: "done", words: all, inferenceMs: performance.now() - t1 });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
