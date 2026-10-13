// How aggressively pauses are removed. Detection runs once at the most
// sensitive setting; each level then filters by length and keeps padding, so
// switching levels is instant and never re-analyses the audio.

import { cutsFromSilences, type Cut, type Range } from "./edl";

export type PauseLevel = "gentle" | "balanced" | "tight";

export const PAUSE_LEVELS: Record<PauseLevel, { label: string; detail: string; minPause: number; padding: number }> = {
  gentle: { label: "Gentle", detail: "Pauses over 1.2 s, generous breathing room", minPause: 1.2, padding: 0.3 },
  balanced: { label: "Balanced", detail: "Pauses over 0.7 s", minPause: 0.7, padding: 0.2 },
  tight: { label: "Tight", detail: "Pauses over 0.45 s, fast pacing", minPause: 0.45, padding: 0.12 },
};

/** The detection floor every level filters from. */
export const MIN_DETECTED_PAUSE = 0.4;

export function pauseCuts(silences: Range[], level: PauseLevel): Cut[] {
  const { minPause, padding } = PAUSE_LEVELS[level];
  return cutsFromSilences(silences.filter((s) => s.end - s.start >= minPause), padding);
}

export const isPauseLevel = (v: unknown): v is PauseLevel =>
  v === "gentle" || v === "balanced" || v === "tight";
