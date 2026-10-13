// Server-side validation for editor payloads. Pure, so it is unit-tested.
//
// Word lists and cut lists arrive from the browser through Server Actions,
// which are public HTTP endpoints: their shape, size and values are untrusted.
// Every field is re-checked here and bounded, independent of what the editor
// UI would ever send.

import { roundMs, type Cut, type CutReason } from "./edl";
import type { Word } from "./align";

export const EDIT_LIMITS = {
  /** ~4.5 h of speech at 150 words/min. */
  maxWords: 40_000,
  maxWordLength: 48,
  maxCuts: 5_000,
  /** Slack over the stored duration, which is rounded to whole seconds. */
  durationSlack: 2,
} as const;

const REASONS: ReadonlySet<CutReason> = new Set(["manual", "silence"]);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Validates a word list. Throws on a wrong overall shape (a malformed request
 * is a bug or an attack, not something to silently half-accept); drops
 * individual words that are out of range.
 */
export function sanitizeWords(input: unknown, maxDuration: number): Word[] {
  if (!Array.isArray(input)) throw new Error("Words must be an array");
  if (input.length > EDIT_LIMITS.maxWords) throw new Error("Transcript is too long");
  const limit = maxDuration + EDIT_LIMITS.durationSlack;

  const words: Word[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const { text, start, end } = raw as Record<string, unknown>;
    if (typeof text !== "string" || !isNum(start) || !isNum(end)) continue;
    const t = text.trim().slice(0, EDIT_LIMITS.maxWordLength);
    if (!t || start < 0 || end < start || end > limit) continue;
    words.push({ text: t, start: roundMs(start), end: roundMs(end) });
  }
  return words.sort((a, b) => a.start - b.start);
}

/**
 * Validates a cut list. Throws on a wrong shape or an oversized list; drops
 * individual cuts that are inverted, empty, out of range or of unknown kind.
 * Cuts are stored unmerged (see lib/media/edl.ts), so overlaps are allowed.
 */
export function sanitizeCuts(input: unknown, maxDuration: number): Cut[] {
  if (!Array.isArray(input)) throw new Error("Cuts must be an array");
  if (input.length > EDIT_LIMITS.maxCuts) throw new Error("Too many cuts");
  const limit = maxDuration + EDIT_LIMITS.durationSlack;

  const cuts: Cut[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const { start, end, reason } = raw as Record<string, unknown>;
    if (!isNum(start) || !isNum(end)) continue;
    if (typeof reason !== "string" || !REASONS.has(reason as CutReason)) continue;
    const s = roundMs(Math.max(0, start));
    const e = roundMs(Math.min(limit, end));
    if (e - s < 0.01) continue;
    cuts.push({ start: s, end: e, reason: reason as CutReason });
  }
  return cuts.sort((a, b) => a.start - b.start);
}
