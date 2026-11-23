// Shared by the export worker and the UI. Deliberately dependency-free: the
// UI imports this at runtime, and importing the worker module instead would
// run its message handler on the main thread and pull the codec library into
// the page bundle.

import type { Range } from "./edl";
import type { AudioFx } from "@/lib/studio/fx";
import type { Caption, CaptionStyle } from "@/lib/studio/captions";
import type { VideoLook } from "@/lib/studio/frame";
import type { AudioMix } from "@/lib/studio/tracks";
import type { AudioFormatId } from "./audioFormats";

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

export type ExportOutput = "mp4" | AudioFormatId;

export type ExportRequest = {
  type: "export";
  url: string;
  segments: Range[];
  preset: ExportPreset;
  /** Audio effects to render into the file; null/inactive copies the audio as is. */
  audioFx?: AudioFx | null;
  /** An audio format renders the edited, processed audio alone. Default "mp4". */
  output?: ExportOutput;
  /** Bitrate for lossy audio-only outputs (MP3, M4A, Opus), kbps. */
  audioKbps?: number;
  /** Captions to burn into the video, in SOURCE time (mapped onto the segments in the worker). */
  captions?: { captions: Caption[]; style: CaptionStyle } | null;
  /** Framing and colour to render (aspect, fit, crop, adjustments). */
  look?: VideoLook | null;
  /** Multitrack audio: original level/mute plus added clips, mixed into the file. */
  mix?: AudioMix | null;
};

export type ExportEvent =
  | {
      type: "start";
      output: ExportOutput;
      width: number;
      height: number;
      videoCodec: string | null;
      audioCodec: string | null;
      editedSeconds: number;
      /** True when audio effects were rendered into the file. */
      audioProcessed: boolean;
      /** Number of captions burned into the video. */
      captionsBurned: number;
      /** Number of added audio clips mixed into the file. */
      tracksMixed: number;
    }
  | { type: "progress"; fraction: number }
  | { type: "done"; buffer: ArrayBuffer; ms: number }
  | { type: "error"; message: string };
