"use client";

import { useEffect, useState } from "react";
import { loadAnalysisAudio, type LoadedAudio } from "./audio";
import { detectSilences } from "./silence";
import { MIN_DETECTED_PAUSE } from "./pauses";
import type { Range } from "./edl";

export type AnalysisState =
  | { status: "loading"; progress: number | null }
  | { status: "error"; message: string }
  | {
      status: "ready";
      audio: LoadedAudio;
      silences: Range[];
      noiseFloorDb: number;
      speechLevelDb: number;
      analysisMs: number;
    };

/**
 * Loads the video's audio once and finds every pause at the most sensitive
 * setting. Pause levels filter this result, so the audio is analysed exactly
 * once per editor session. Analysis is O(n) over 16 kHz mono and measured.
 */
export function useAudioAnalysis(videoUrl: string): AnalysisState {
  const [state, setState] = useState<AnalysisState>({ status: "loading", progress: 0 });

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", progress: 0 });
    (async () => {
      try {
        const audio = await loadAnalysisAudio(
          videoUrl,
          (progress) => setState({ status: "loading", progress }),
          controller.signal
        );
        const t0 = performance.now();
        const a = detectSilences(audio.samples, audio.sampleRate, { minSilence: MIN_DETECTED_PAUSE });
        setState({
          status: "ready",
          audio,
          silences: a.silences,
          noiseFloorDb: a.noiseFloorDb,
          speechLevelDb: a.speechLevelDb,
          analysisMs: performance.now() - t0,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        setState({ status: "error", message: err instanceof Error ? err.message : "Couldn't analyse the audio." });
      }
    })();
    return () => controller.abort();
  }, [videoUrl]);

  return state;
}
