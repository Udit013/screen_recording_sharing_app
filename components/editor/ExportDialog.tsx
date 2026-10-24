"use client";

import { useEffect, useState } from "react";
import { useExporter } from "@/lib/media/useExporter";
import { EXPORT_PRESETS, type ExportPreset } from "@/lib/media/export-presets";
import type { Range } from "@/lib/media/edl";
import { formatDuration } from "@/lib/utils";
import { useModal } from "@/lib/useModal";

interface ExportDialogProps {
  videoUrl: string;
  title: string;
  segments: Range[];
  editedSeconds: number;
  /** Rendering a selected clip rather than the whole edit. */
  selection?: boolean;
  onClose: () => void;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
const CODEC_NAMES: Record<string, string> = { avc: "H.264", vp9: "VP9", av1: "AV1", aac: "AAC", opus: "Opus" };

export default function ExportDialog({ videoUrl, title, segments, editedSeconds, selection = false, onClose }: ExportDialogProps) {
  const [preset, setPreset] = useState<ExportPreset>("720p");
  const [sourceBytes, setSourceBytes] = useState<number | null>(null);
  const { state, start, reset } = useExporter();
  const busy = state.phase === "preparing" || state.phase === "rendering";

  // Real source size (Cloudinary exposes Content-Length to CORS), so the
  // savings shown after export are measured, not estimated.
  useEffect(() => {
    fetch(videoUrl, { method: "HEAD" })
      .then((r) => setSourceBytes(Number(r.headers.get("content-length")) || null))
      .catch(() => setSourceBytes(null));
  }, [videoUrl]);

  // Esc closes (unless a render is running), Tab stays inside, focus returns
  // to the button that opened the dialog.
  const dialogRef = useModal<HTMLDivElement>(true, () => { if (!busy) onClose(); });

  const fileName = `${title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "snapcast"}-${selection ? "clip" : "edited"}.mp4`;

  return (
    <div className="ex-overlay" onClick={() => !busy && onClose()}>
      <div ref={dialogRef} className="ex-dialog" role="dialog" aria-modal="true" aria-labelledby="ex-title" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <header className="ex-head">
          <div>
            <h2 id="ex-title">{selection ? "Export clip" : "Export edited video"}</h2>
            <p>
              {formatDuration(Math.round(editedSeconds)) || "0:00"} · {segments.length}{" "}
              {segments.length === 1 ? "segment" : "segments"} · rendered on this device
            </p>
          </div>
          <button className="ex-close" onClick={onClose} disabled={busy} aria-label="Close export">×</button>
        </header>

        {state.phase === "idle" || state.phase === "error" ? (
          <>
            <fieldset className="ex-presets">
              <legend className="sr-only">Quality preset</legend>
              {(Object.keys(EXPORT_PRESETS) as ExportPreset[]).map((p) => (
                <label key={p} className={p === preset ? "ex-preset is-on" : "ex-preset"}>
                  <input type="radio" name="preset" value={p} checked={p === preset} onChange={() => setPreset(p)} />
                  <span className="ex-preset-label">{EXPORT_PRESETS[p].label}</span>
                  <span className="ex-preset-detail">{EXPORT_PRESETS[p].detail}</span>
                </label>
              ))}
            </fieldset>
            {state.phase === "error" && <p className="ex-error" role="alert">{state.message}</p>}
            <p className="ex-note">
              Encoded with your device&apos;s hardware encoder via WebCodecs. Nothing is uploaded; the original video is untouched.
            </p>
            <footer className="ex-foot">
              <button className="ed-btn" onClick={onClose}>Cancel</button>
              <button className="ed-btn is-primary" onClick={() => start(videoUrl, segments, preset)}>Render MP4</button>
            </footer>
          </>
        ) : state.phase === "done" ? (
          <>
            <video className="ex-preview" src={state.url} controls playsInline />
            <dl className="ex-stats">
              <div><dt>File size</dt><dd>{mb(state.bytes)}</dd></div>
              {sourceBytes && (
                <div>
                  <dt>vs. original</dt>
                  <dd>
                    {mb(sourceBytes)} →{" "}
                    {state.bytes <= sourceBytes
                      ? `${Math.round((1 - state.bytes / sourceBytes) * 100)}% smaller`
                      : `${Math.round((state.bytes / sourceBytes - 1) * 100)}% larger`}
                  </dd>
                </div>
              )}
              <div><dt>Resolution</dt><dd>{state.width}×{state.height}</dd></div>
              <div><dt>Codecs</dt><dd>{CODEC_NAMES[state.videoCodec] ?? state.videoCodec}{state.audioCodec ? ` + ${CODEC_NAMES[state.audioCodec] ?? state.audioCodec}` : ", no audio"}</dd></div>
              <div><dt>Render time</dt><dd>{(state.ms / 1000).toFixed(1)}s ({(state.editedSeconds / (state.ms / 1000)).toFixed(1)}× real time)</dd></div>
            </dl>
            <footer className="ex-foot">
              <button className="ed-btn" onClick={reset}>Render again</button>
              <a className="ed-btn is-primary" href={state.url} download={fileName}>Download MP4</a>
            </footer>
          </>
        ) : (
          <div className="ex-progress-wrap">
            <div
              className="ex-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={state.phase === "rendering" ? Math.round(state.fraction * 100) : 0}
            >
              <div style={{ width: `${state.phase === "rendering" ? state.fraction * 100 : 0}%` }} />
            </div>
            <p className="ex-progress-label">
              {state.phase === "preparing"
                ? "Reading the source and negotiating codecs…"
                : `Rendering ${Math.round(state.fraction * 100)}% · ${state.width}×${state.height} ${CODEC_NAMES[state.videoCodec] ?? state.videoCodec}`}
            </p>
            <footer className="ex-foot">
              <button className="ed-btn" onClick={reset}>Cancel</button>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
