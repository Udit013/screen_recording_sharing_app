// Undo/redo for the cut list. A pure reducer, so the editor's history
// behaviour is unit-tested rather than exercised only by hand.

import type { Cut } from "./edl";

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

/** Bounded so a long session can't grow memory without limit. */
export const MAX_HISTORY = 100;

export function historyReducer(state: History, action: HistoryAction): History {
  switch (action.type) {
    case "commit":
      if (sameCuts(state.present, action.cuts)) return state;
      return {
        past: [...state.past, state.present].slice(-MAX_HISTORY),
        present: action.cuts,
        future: [],
      };
    case "undo": {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1];
      return { past: state.past.slice(0, -1), present: previous, future: [state.present, ...state.future] };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const [next, ...rest] = state.future;
      return { past: [...state.past, state.present], present: next, future: rest };
    }
    case "reset":
      return { past: [], present: action.cuts, future: [] };
  }
}

export function sameCuts(a: Cut[], b: Cut[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => c.start === b[i].start && c.end === b[i].end && c.reason === b[i].reason);
}
