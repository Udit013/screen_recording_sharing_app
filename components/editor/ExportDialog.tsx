"use client";

import { useEffect, useMemo, useState } from "react";
import { useExporter } from "@/lib/media/useExporter";
import { EXPORT_PRESETS, type ExportOutput, type ExportPreset } from "@/lib/media/export-presets";
import { isFxActive, type AudioFx } from "@/lib/studio/fx";
import { captionsForSegments, type Caption, type CaptionStyle } from "@/lib/studio/captions";
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
  /** The Audio tab's effects; rendered into the file when active. */
  audioFx?: AudioFx | null;
  /** The caption track (source time) when "burn in" is on; null otherwise. */
  captions?: { captions: Caption[]; style: CaptionStyle } | null;
  onClose: () => void;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
const CODEC_NAMES: Record<string, string> = { avc: "H.264", vp9: "VP9", av1: "AV1", aac: "AAC", opus: "Opus", "pcm-s16": "16-bit PCM" };
const codecName = (c: string | null) => (c ? CODEC_NAMES[c] ?? c : "");

export default function ExportDialog({
  videoUrl, title, segments, editedSeconds, selection = false, audioFx = null, captions = null, onClose,
}: ExportDialogProps) {
  const [preset, setPreset] = useState<ExportPreset>("720p");
  const [output, setOutput] = useState<ExportOutput>("mp4");
  const fxAvailable = isFxActive(audioFx);
  const [withFx, setWithFx] = useState(true);
  const captionCount = useMemo(() => (captions ? captionsForSegments(captions.captions, segments).length : 0), [captions, segments]);
  const [withCaptions, setWithCaptions] = useState(true);
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

  const doneOutput = state.phase === "done" ? state.output : output;
  const fileName = `${title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "snapcast"}-${selection ? "clip" : "edited"}.${doneOutput}`;

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
            <div className="ex-seg" role="radiogroup" aria-label="Output">
              {(["mp4", "wav"] as const).map((o) => (
                <button key={o} type="button" role="radio" aria-checked={output === o} className={output === o ? "is-on" : undefined}
                  onClick={() => setOutput(o)}>
                  {o === "mp4" ? "Video (MP4)" : "Audio only (WAV)"}
                </button>
              ))}
            </div>
            {output === "mp4" && (
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
            )}
            <label className={fxAvailable ? "ex-check" : "ex-check is-disabled"}>
              <input type="checkbox" checked={fxAvailable && withFx} disabled={!fxAvailable} onChange={(e) => setWithFx(e.target.checked)} />
              <span>
                Render audio effects
                <small>{fxAvailable ? "From the Audio tab, at the source's full sample rate, in stereo." : "No audio effects are on. Set them up in the Audio tab."}</small>
              </span>
            </label>
            {output === "mp4" && (
              <label className={captionCount > 0 ? "ex-check" : "ex-check is-disabled"}>
                <input type="checkbox" checked={captionCount > 0 && withCaptions} disabled={captionCount === 0}
                  onChange={(e) => setWithCaptions(e.target.checked)} />
                <span>
                  Burn in captions
                  <small>
                    {captionCount > 0
                      ? `${captionCount} ${captionCount === 1 ? "caption" : "captions"}, drawn exactly as in the preview.`
                      : "No captions to burn in. Add them in the Captions tab."}
                  </small>
                </span>
              </label>
            )}
            {state.phase === "error" && <p className="ex-error" role="alert">{state.message}</p>}
            <p className="ex-note">
              Encoded with your device&apos;s hardware encoder via WebCodecs. Nothing is uploaded; the original video is untouched.
            </p>
            <footer className="ex-foot">
              <button className="ed-btn" onClick={onClose}>Cancel</button>
              <button
                className="ed-btn is-primary"
                onClick={() => start(videoUrl, segments, preset, {
                  output,
                  audioFx: fxAvailable && withFx ? audioFx : null,
                  captions: output === "mp4" && captionCount > 0 && withCaptions ? captions : null,
                })}
              >
                {output === "mp4" ? "Render MP4" : "Render WAV"}
              </button>
            </footer>
          </>
        ) : state.phase === "done" ? (
          <>
            {state.output === "wav"
              ? <audio className="ex-preview-audio" src={state.url} controls />
              : <video className="ex-preview" src={state.url} controls playsInline />}
            <dl className="ex-stats">
              <div><dt>File size</dt><dd>{mb(state.bytes)}</dd></div>
              {sourceBytes && state.output === "mp4" && (
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
              {state.output === "mp4" && <div><dt>Resolution</dt><dd>{state.width}×{state.height}</dd></div>}
              <div><dt>Codecs</dt><dd>{state.output === "mp4" ? codecName(state.videoCodec) : ""}{state.audioCodec ? `${state.output === "mp4" ? " + " : ""}${codecName(state.audioCodec)}` : ", no audio"}</dd></div>
              {state.output === "mp4" && <div><dt>Captions</dt><dd>{state.captionsBurned > 0 ? `${state.captionsBurned} burned in` : "None"}</dd></div>}
              <div><dt>Audio effects</dt><dd>{state.audioProcessed ? "Rendered into the file" : "None (original audio)"}</dd></div>
              <div><dt>Render time</dt><dd>{(state.ms / 1000).toFixed(1)}s ({(state.editedSeconds / (state.ms / 1000)).toFixed(1)}× real time)</dd></div>
            </dl>
            <footer className="ex-foot">
              <button className="ed-btn" onClick={reset}>Render again</button>
              <a className="ed-btn is-primary" href={state.url} download={fileName}>Download {state.output.toUpperCase()}</a>
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
                : state.output === "wav"
                  ? `Rendering audio ${Math.round(state.fraction * 100)}%${state.audioProcessed ? " · with effects" : ""}`
                  : `Rendering ${Math.round(state.fraction * 100)}% · ${state.width}×${state.height} ${codecName(state.videoCodec)}${state.audioProcessed ? " · audio effects" : ""}`}
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
