// Minimal typed wrapper around the browser SpeechRecognition API.
// Captures spoken narration during recording into timestamped segments.
// Chrome/Edge only; degrades gracefully (supported=false) elsewhere.

import { formatDuration } from "@/lib/utils";

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface Transcriber {
  supported: boolean;
  start: () => void;
  stop: () => void;
  getSegments: () => TranscriptEntry[];
}

export function createTranscriber(
  getElapsedSeconds: () => number
): Transcriber {
  const Ctor = getCtor();
  const segments: TranscriptEntry[] = [];

  if (!Ctor) {
    return {
      supported: false,
      start: () => {},
      stop: () => {},
      getSegments: () => segments,
    };
  }

  const recognition = new Ctor();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = "en-US";
  let active = false;

  recognition.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      if (result.isFinal) {
        const text = result[0].transcript.trim();
        if (text) {
          segments.push({
            time: formatDuration(Math.floor(getElapsedSeconds())) || "0:00",
            text,
          });
        }
      }
    }
  };

  // Auto-restart on transient end while recording is active.
  recognition.onend = () => {
    if (active) {
      try {
        recognition.start();
      } catch {
        /* ignore double-start */
      }
    }
  };
  recognition.onerror = () => {};

  return {
    supported: true,
    start: () => {
      active = true;
      try {
        recognition.start();
      } catch {
        /* already started */
      }
    },
    stop: () => {
      active = false;
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    },
    getSegments: () => segments,
  };
}
