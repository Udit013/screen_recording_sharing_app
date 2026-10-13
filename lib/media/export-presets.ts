// Shared by the export worker and the UI. Deliberately dependency-free: the
// UI imports this at runtime, and importing the worker module instead would
// run its message handler on the main thread and pull the codec library into
// the page bundle.

import type { Range } from "./edl";

export type ExportPreset = "original" | "1080p" | "720p" | "compact";
export type ExportQuality = "high" | "medium" | "low";

export const EXPORT_PRESETS: Record<
  ExportPreset,
  { label: string; detail: string; maxHeight: number | null; quality: ExportQuality }
> = {
  original: { label: "Original", detail: "Source resolution, high quality", maxHeight: null, quality: "high" },
  "1080p": { label: "1080p", detail: "Full HD, high quality", maxHeight: 1080, quality: "high" },
  "720p": { label: "720p", detail: "HD, balanced size", maxHeight: 720, quality: "medium" },
  compact: { label: "Compact", detail: "480p, smallest file", maxHeight: 480, quality: "low" },
};

export type ExportRequest = {
  type: "export";
  url: string;
  segments: Range[];
  preset: ExportPreset;
};

export type ExportEvent =
  | {
      type: "start";
      width: number;
      height: number;
      videoCodec: string;
      audioCodec: string | null;
      editedSeconds: number;
    }
  | { type: "progress"; fraction: number }
  | { type: "done"; buffer: ArrayBuffer; ms: number }
  | { type: "error"; message: string };
