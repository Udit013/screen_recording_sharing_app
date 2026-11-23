// The editor's undoable document: the cut list plus the Audio Studio
// settings. One history for both, so ⌘Z undoes whichever changed last.

import type { Cut } from "@/lib/media/edl";
import { createHistoryReducer, sameCuts, type HistoryOf } from "@/lib/media/history";
import type { AudioFx } from "./fx";

export interface EditDoc {
  cuts: Cut[];
  fx: AudioFx;
}

export const sameDoc = (a: EditDoc, b: EditDoc): boolean =>
  sameCuts(a.cuts, b.cuts) && (a.fx === b.fx || JSON.stringify(a.fx) === JSON.stringify(b.fx));

export const docHistoryReducer = createHistoryReducer<EditDoc>(sameDoc);

export const initialDocHistory = (doc: EditDoc): HistoryOf<EditDoc> => ({ past: [], present: doc, future: [] });
