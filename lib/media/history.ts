// Undo/redo as a pure reducer, so the editor's history behaviour is
// unit-tested rather than exercised only by hand.
//
// Generic over the document being edited. The editor's document is the cut
// list plus the Audio Studio settings, so ⌘Z undoes whichever changed last.
// Commits can carry a merge key: consecutive commits with the same key within
// MERGE_WINDOW_MS replace the present instead of stacking, so dragging one
// slider becomes one undo step rather than hundreds.

import type { Cut } from "./edl";

export interface HistoryOf<T> {
  past: T[];
  present: T;
  future: T[];
  /** Merge key and time of the last commit (see above). */
  lastKey?: string | null;
  lastAt?: number;
}

export type HistoryOfAction<T> =
  | { type: "commit"; value: T; mergeKey?: string; at?: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; value: T };

/** Bounded so a long session can't grow memory without limit. */
export const MAX_HISTORY = 100;
export const MERGE_WINDOW_MS = 800;

export function createHistoryReducer<T>(equals: (a: T, b: T) => boolean) {
  return function reduce(state: HistoryOf<T>, action: HistoryOfAction<T>): HistoryOf<T> {
    switch (action.type) {
      case "commit": {
        if (equals(state.present, action.value)) return state;
        const at = action.at ?? 0;
        const merge =
          action.mergeKey != null &&
          action.mergeKey === state.lastKey &&
          state.lastAt != null &&
          at - state.lastAt <= MERGE_WINDOW_MS;
        if (merge) return { ...state, present: action.value, future: [], lastAt: at };
        return {
          past: [...state.past, state.present].slice(-MAX_HISTORY),
          present: action.value,
          future: [],
          lastKey: action.mergeKey ?? null,
          lastAt: at,
        };
      }
      case "undo": {
        if (state.past.length === 0) return state;
        const previous = state.past[state.past.length - 1];
        return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future], lastKey: null };
      }
      case "redo": {
        if (state.future.length === 0) return state;
        const [next, ...rest] = state.future;
        return { past: [...state.past, state.present], present: next, future: rest, lastKey: null };
      }
      case "reset":
        return { past: [], present: action.value, future: [], lastKey: null };
    }
  };
}

// ── The cut-list history (the original API, kept for its callers/tests) ──

export interface History {
  past: Cut[][];
  present: Cut[];
  future: Cut[][];
}

export type HistoryAction =
  | { type: "commit"; cuts: Cut[] }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; cuts: Cut[] };

const cutsReducer = createHistoryReducer<Cut[]>(sameCuts);

export function historyReducer(state: History, action: HistoryAction): History {
  const next =
    action.type === "commit"
      ? cutsReducer(state, { type: "commit", value: action.cuts })
      : action.type === "reset"
        ? cutsReducer(state, { type: "reset", value: action.cuts })
        : cutsReducer(state, action);
  if (next === state) return state;
  return { past: next.past, present: next.present, future: next.future };
}

export function sameCuts(a: Cut[], b: Cut[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => c.start === b[i].start && c.end === b[i].end && c.reason === b[i].reason);
}
