"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadedAudio } from "./audio";
import { planTranscriptionWindows } from "./silence";
import type { Range } from "./edl";
import type { Word } from "./align";
import type { TranscribeEvent, TranscribeRequest } from "./transcribe.worker";

export type TranscriberState =
  | { phase: "idle" }
  | { phase: "model"; loaded: number; total: number }
  | { phase: "transcribing"; done: number; total: number; words: Word[] }
  | { phase: "done"; words: Word[]; loadMs: number; inferenceMs: number; audioSeconds: number }
  | { phase: "error"; message: string };

/** Runs Whisper in a worker; cancel() terminates it outright. */
export function useTranscriber() {
  const [state, setState] = useState<TranscriberState>({ phase: "idle" });
  const workerRef = useRef<Worker | null>(null);

  const cancel = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    setState({ phase: "idle" });
  }, []);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const start = useCallback((audio: LoadedAudio, silences: Range[]) => {
    workerRef.current?.terminate();
    const worker = new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;

    // Model files download in parallel; aggregate bytes across them.
    const files = new Map<string, { loaded: number; total: number }>();
    let loadMs = 0;
    const words: Word[] = [];
    setState({ phase: "model", loaded: 0, total: 0 });

    worker.onmessage = (e: MessageEvent<TranscribeEvent>) => {
      const m = e.data;
      if (m.type === "model") {
        files.set(m.file, { loaded: m.loaded, total: m.total });
        let loaded = 0, total = 0;
        files.forEach((f) => { loaded += f.loaded; total += f.total; });
        setState({ phase: "model", loaded, total });
      } else if (m.type === "ready") {
        loadMs = m.loadMs;
      } else if (m.type === "window") {
        words.push(...m.words);
        setState({ phase: "transcribing", done: m.index + 1, total: m.total, words: [...words] });
      } else if (m.type === "done") {
        setState({ phase: "done", words: m.words, loadMs, inferenceMs: m.inferenceMs, audioSeconds: audio.duration });
        worker.terminate();
        workerRef.current = null;
      } else if (m.type === "error") {
        setState({ phase: "error", message: m.message });
        worker.terminate();
        workerRef.current = null;
      }
    };
    worker.onerror = (e) => setState({ phase: "error", message: e.message || "The transcription worker crashed." });

    const windows = planTranscriptionWindows(audio.duration, silences);
    // Transfer a copy: the editor keeps its own samples for the waveform.
    const copy = audio.samples.slice();
    const req: TranscribeRequest = { type: "transcribe", audio: copy, sampleRate: audio.sampleRate, windows };
    worker.postMessage(req, [copy.buffer]);
  }, []);

  return { state, start, cancel };
}
