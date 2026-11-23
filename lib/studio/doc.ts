// The editor's undoable document: the cut list, the Audio Studio settings,
// the caption track and the video framing. One history for all of them, so ⌘Z undoes whichever
// changed last.

import type { Cut } from "@/lib/media/edl";
import { createHistoryReducer, sameCuts, type HistoryOf } from "@/lib/media/history";
import type { AudioFx } from "./fx";
import type { CaptionTrack } from "./captions";
import type { VideoLook } from "./frame";

export interface EditDoc {
  cuts: Cut[];
  fx: AudioFx;
  captions: CaptionTrack;
  look: VideoLook;
}

const sameJson = <T,>(a: T, b: T) => a === b || JSON.stringify(a) === JSON.stringify(b);

export const sameDoc = (a: EditDoc, b: EditDoc): boolean =>
  sameCuts(a.cuts, b.cuts) && sameJson(a.fx, b.fx) && sameJson(a.captions, b.captions) && sameJson(a.look, b.look);

export const docHistoryReducer = createHistoryReducer<EditDoc>(sameDoc);

export const initialDocHistory = (doc: EditDoc): HistoryOf<EditDoc> => ({ past: [], present: doc, future: [] });
