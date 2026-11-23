"use client";

// Convert: video → audio and audio → video, entirely in the browser. Files
// are read locally and never uploaded; encoding runs in a worker
// (lib/media/convert.worker.ts) with the device's WebCodecs encoders.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AUDIO_BITRATES, AUDIO_FORMATS, DEFAULT_AUDIO_KBPS, estimateAudioBytes, formatBytes, maxKbps, type AudioFormatId,
} from "@/lib/media/audioFormats";
import {
  COVER_ASPECTS, COVER_SIZES, coverSize, drawCover, estimateVideoBytes, toAnalysis, videoKbps,
  type CoverOptions, type VisualizerStyle,
} from "@/lib/studio/visualizer";
import type { ConvertEvent, ConvertRequest } from "@/lib/media/convert.worker";

type Mode = "toAudio" | "toVideo";
type Job =
  | { phase: "idle" }
  | { phase: "running"; fraction: number; stage: string }
  | { phase: "done"; url: string; bytes: number; mime: string; name: string; ms: number; seconds: number; width?: number; height?: number; codecs: string }
  | { phase: "error"; message: string };

const MAX_FILE = 2 * 1024 * 1024 * 1024;
const baseName = (f: File) => f.name.replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, "").trim() || "snapcast";

/** Duration of a local media file via a throwaway media element. */
function probeDuration(file: File, kind: "audio" | "video"): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    const url = URL.createObjectURL(file);
    el.preload = "metadata";
    el.onloadedmetadata = () => { resolve(Number.isFinite(el.duration) ? el.duration : 0); URL.revokeObjectURL(url); };
    el.onerror = () => { resolve(0); URL.revokeObjectURL(url); };
    el.src = url;
  });
}

export default function ConvertPage() {
  const [mode, setMode] = useState<Mode>("toAudio");
  const [job, setJob] = useState<Job>({ phase: "idle" });
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => () => workerRef.current?.terminate(), []);
  useEffect(() => () => { if (job.phase === "done") URL.revokeObjectURL(job.url); }, [job]);

  const run = (req: ConvertRequest, name: string) => {
    workerRef.current?.terminate();
    const w = new Worker(new URL("../../../lib/media/convert.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    setJob({ phase: "running", fraction: 0, stage: "Starting" });
    w.onmessage = (e: MessageEvent<ConvertEvent>) => {
      const m = e.data;
      if (m.type === "progress") setJob({ phase: "running", fraction: m.fraction, stage: m.stage });
      else if (m.type === "done") {
        const blob = new Blob([m.buffer], { type: m.mime });
        setJob({ phase: "done", url: URL.createObjectURL(blob), bytes: blob.size, mime: m.mime, name, ms: m.ms, seconds: m.seconds, width: m.width, height: m.height, codecs: m.codecs });
        w.terminate(); workerRef.current = null;
      } else {
        setJob({ phase: "error", message: m.message });
        w.terminate(); workerRef.current = null;
      }
    };
    w.onerror = (e) => setJob({ phase: "error", message: e.message || "The converter crashed." });
    w.postMessage(req);
  };
  const cancel = () => { workerRef.current?.terminate(); workerRef.current = null; setJob({ phase: "idle" }); };
  const busy = job.phase === "running";

  return (
    <main className="wrapper-md convert-page">
      <h1>Convert</h1>
      <p className="cv-lead">Runs on this device. Your files are never uploaded.</p>

      <div className="ex-seg cv-modes" role="radiogroup" aria-label="Conversion">
        {([["toAudio", "Video → Audio"], ["toVideo", "Audio → Video"]] as const).map(([m, label]) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "is-on" : undefined}
            disabled={busy} onClick={() => { setMode(m); setJob({ phase: "idle" }); }}>{label}</button>
        ))}
      </div>

      {mode === "toAudio" ? <ToAudio busy={busy} onRun={run} /> : <ToVideo busy={busy} onRun={run} />}

      {job.phase === "running" && (
        <div className="cv-progress" role="status">
          <div className="cv-bar"><span style={{ width: `${Math.round(job.fraction * 100)}%` }} /></div>
          <span>{job.stage}… {Math.round(job.fraction * 100)}%</span>
          <button className="ed-btn is-small" onClick={cancel}>Cancel</button>
        </div>
      )}
      {job.phase === "error" && <p className="ex-error" role="alert">{job.message}</p>}
      {job.phase === "done" && (
        <section className="cv-result" aria-label="Result">
          {job.mime.startsWith("video/")
            ? <video src={job.url} controls playsInline className="cv-result-video" />
            : <audio src={job.url} controls />}
          <dl className="ex-stats">
            <div><dt>File size</dt><dd>{formatBytes(job.bytes)}</dd></div>
            <div><dt>Length</dt><dd>{job.seconds.toFixed(1)} s</dd></div>
            {job.width && <div><dt>Resolution</dt><dd>{job.width}×{job.height}</dd></div>}
            <div><dt>Format</dt><dd>{job.codecs}</dd></div>
            <div><dt>Time</dt><dd>{(job.ms / 1000).toFixed(1)} s ({(job.seconds / (job.ms / 1000)).toFixed(1)}× real time)</dd></div>
          </dl>
          <a className="ed-btn is-primary" href={job.url} download={job.name}>Download</a>
        </section>
      )}
    </main>
  );
}

function FilePick({ label, accept, file, onFile, disabled }: { label: string; accept: string; file: File | null; onFile: (f: File | null) => void; disabled?: boolean }) {
  return (
    <label className="cv-file">
      <span>{label}</span>
      <input type="file" accept={accept} disabled={disabled} onChange={(e) => {
        const f = e.target.files?.[0] ?? null;
        onFile(f && f.size <= MAX_FILE ? f : null);
      }} />
      {file && <small>{file.name} · {formatBytes(file.size)}</small>}
    </label>
  );
}

function ToAudio({ busy, onRun }: { busy: boolean; onRun: (r: ConvertRequest, name: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [format, setFormat] = useState<AudioFormatId>("mp3");
  const [kbps, setKbps] = useState<number>(DEFAULT_AUDIO_KBPS);
  useEffect(() => { if (file) probeDuration(file, "video").then(setDuration); else setDuration(0); }, [file]);
  const rate = Math.min(kbps, maxKbps(format));
  return (
    <section className="cv-panel">
      <FilePick label="Video or audio file" accept="video/*,audio/*" file={file} onFile={setFile} disabled={busy} />
      <fieldset className="cv-formats">
        <legend>Format</legend>
        {(Object.keys(AUDIO_FORMATS) as AudioFormatId[]).map((f) => (
          <label key={f} className={format === f ? "ex-preset is-on" : "ex-preset"}>
            <input type="radio" name="fmt" checked={format === f} onChange={() => setFormat(f)} />
            <span className="ex-preset-label">{AUDIO_FORMATS[f].label}</span>
            <span className="ex-preset-detail">{AUDIO_FORMATS[f].detail}</span>
          </label>
        ))}
      </fieldset>
      {format !== "wav" && (
        <label className="cv-row">
          <span>Bitrate</span>
          <select value={kbps} onChange={(e) => setKbps(Number(e.target.value))}>
            {AUDIO_BITRATES.filter((b) => b <= maxKbps(format)).map((b) => <option key={b} value={b}>{b} kbps</option>)}
          </select>
        </label>
      )}
      <p className="cv-estimate">
        {duration > 0 ? <>Estimated size: <strong>{formatBytes(estimateAudioBytes(format, rate, duration))}</strong> for {duration.toFixed(1)} s</> : "Choose a file to see the estimated size."}
      </p>
      <button className="ed-btn is-primary" disabled={!file || busy}
        onClick={() => file && onRun({ type: "toAudio", file, format, kbps: rate }, `${baseName(file)}.${AUDIO_FORMATS[format].ext}`)}>
        Convert to {AUDIO_FORMATS[format].label}
      </button>
    </section>
  );
}

function ToVideo({ busy, onRun }: { busy: boolean; onRun: (r: ConvertRequest, name: string) => void }) {
  const [audio, setAudio] = useState<File | null>(null);
  const [image, setImage] = useState<File | null>(null);
  const [duration, setDuration] = useState(0);
  const [opts, setOpts] = useState<CoverOptions>({ aspect: "9:16", shortSide: 720, fps: 30, background: "#16131f", accent: "#ff4393", visualizer: "bars", title: "", dim: 0.35 });
  const [quality, setQuality] = useState<"low" | "medium" | "high">("medium");
  const [audioKbps, setAudioKbps] = useState(192);
  const set = (p: Partial<CoverOptions>) => setOpts((o) => ({ ...o, ...p }));
  const size = coverSize(opts);
  const vk = videoKbps(quality, size.width, size.height);
  useEffect(() => { if (audio) probeDuration(audio, "audio").then(setDuration); else setDuration(0); }, [audio]);

  // Live preview: the same drawCover as the encoder, driven by an <audio>.
  const canvas = useRef<HTMLCanvasElement>(null);
  const player = useRef<HTMLAudioElement>(null);
  const [analysis, setAnalysis] = useState<Float32Array | null>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const audioUrl = useMemo(() => (audio ? URL.createObjectURL(audio) : null), [audio]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  useEffect(() => {
    let alive = true;
    setAnalysis(null);
    if (!audio) return;
    audio.arrayBuffer().then((b) => new OfflineAudioContext(1, 1, 48000).decodeAudioData(b)).then((buf) => {
      if (!alive) return;
      setAnalysis(toAnalysis(Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i)), buf.sampleRate));
    }).catch(() => {});
    return () => { alive = false; };
  }, [audio]);
  useEffect(() => {
    let alive = true;
    if (!image) { setBitmap(null); return; }
    createImageBitmap(image).then((b) => { if (alive) setBitmap(b); }).catch(() => setBitmap(null));
    return () => { alive = false; };
  }, [image]);
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const scale = 360 / Math.max(size.width, size.height);
    cv.width = Math.round(size.width * scale * (window.devicePixelRatio || 1));
    cv.height = Math.round(size.height * scale * (window.devicePixelRatio || 1));
    let raf = 0;
    const frame = () => {
      // Draw at a reduced size with the same proportions as the output.
      drawCover(ctx, cv.width, cv.height, opts, bitmap, analysis, player.current?.currentTime ?? 0);
      raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [opts, bitmap, analysis, size.width, size.height]);

  return (
    <section className="cv-panel cv-video">
      <div className="cv-controls">
        <FilePick label="Audio file" accept="audio/*,video/*" file={audio} onFile={setAudio} disabled={busy} />
        <fieldset className="vs-aspects">
          <legend>Shape</legend>
          {COVER_ASPECTS.map((a) => (
            <button key={a.id} type="button" aria-pressed={opts.aspect === a.id} className={opts.aspect === a.id ? "vs-aspect is-on" : "vs-aspect"} onClick={() => set({ aspect: a.id })}>
              <span className="vs-aspect-shape" aria-hidden style={{ aspectRatio: String(a.ratio) }} />
              <strong>{a.label}</strong><small>{a.hint}</small>
            </button>
          ))}
        </fieldset>
        <label className="cv-row"><span>Resolution</span>
          <select value={opts.shortSide} onChange={(e) => set({ shortSide: Number(e.target.value) })}>
            {COVER_SIZES.map((s) => { const z = coverSize({ aspect: opts.aspect, shortSide: s }); return <option key={s} value={s}>{z.width}×{z.height}</option>; })}
          </select>
        </label>
        <label className="cv-row"><span>Quality</span>
          <select value={quality} onChange={(e) => setQuality(e.target.value as typeof quality)}>
            <option value="low">Low ({videoKbps("low", size.width, size.height)} kbps)</option>
            <option value="medium">Medium ({videoKbps("medium", size.width, size.height)} kbps)</option>
            <option value="high">High ({videoKbps("high", size.width, size.height)} kbps)</option>
          </select>
        </label>
        <label className="cv-row"><span>Audio bitrate</span>
          <select value={audioKbps} onChange={(e) => setAudioKbps(Number(e.target.value))}>
            {[96, 128, 192, 256].map((b) => <option key={b} value={b}>{b} kbps</option>)}
          </select>
        </label>
        <label className="cv-row"><span>Frame rate</span>
          <select value={opts.fps} onChange={(e) => set({ fps: Number(e.target.value) })}>
            {[24, 30, 60].map((f) => <option key={f} value={f}>{f} fps</option>)}
          </select>
        </label>
        <label className="cv-row"><span>Visualizer</span>
          <select value={opts.visualizer} onChange={(e) => set({ visualizer: e.target.value as VisualizerStyle })}>
            <option value="bars">Spectrum bars</option>
            <option value="wave">Waveform</option>
            <option value="none">None (still image)</option>
          </select>
        </label>
        <label className="cv-row"><span>Background colour</span><input type="color" value={opts.background} onChange={(e) => set({ background: e.target.value })} /></label>
        <label className="cv-row"><span>Visualizer colour</span><input type="color" value={opts.accent} onChange={(e) => set({ accent: e.target.value })} /></label>
        <FilePick label="Background image (optional)" accept="image/*" file={image} onFile={setImage} disabled={busy} />
        {image && <button type="button" className="ed-link" onClick={() => setImage(null)}>Remove image</button>}
        <label className="cv-row cv-title"><span>Title (optional)</span>
          <input type="text" value={opts.title} maxLength={80} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Episode 12" />
        </label>
        <p className="cv-estimate">
          {duration > 0
            ? <>Estimated size: up to <strong>{formatBytes(estimateVideoBytes(vk, audioKbps, duration))}</strong> for {duration.toFixed(1)} s at {size.width}×{size.height}{opts.visualizer === "none" ? " (a still image comes out much smaller)" : ""}</>
            : "Choose an audio file to see the estimated size."}
        </p>
        <button className="ed-btn is-primary" disabled={!audio || busy}
          onClick={() => audio && onRun({ type: "toVideo", audio, image, options: opts, videoKbps: vk, audioKbps, fontOrigin: location.origin }, `${baseName(audio)}-${opts.aspect.replace(":", "x")}.mp4`)}>
          Render MP4
        </button>
      </div>
      <div className="cv-preview">
        <canvas ref={canvas} aria-label="Preview" />
        {audioUrl && <audio ref={player} src={audioUrl} controls />}
      </div>
    </section>
  );
}
