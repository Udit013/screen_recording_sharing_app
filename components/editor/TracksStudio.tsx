"use client";

// The Tracks tab: the recording's own audio plus added tracks of music,
// voiceover and sound effects. Clips sit on the edited timeline; drag a clip
// to move it, drag its edges to trim, split it at the playhead. Everything is
// previewed live and mixed into MP4 and WAV exports by the same gains.

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  addClip, addTrack, clipEnd, clipLength, findClip, KIND_LABELS, MIX_LIMITS, mixEnd, moveClip, removeClip, removeTrack,
  splitClip, trimClip, updateClip, updateTrack, type AudioClip, type AudioMix, type TrackKind,
} from "@/lib/studio/tracks";
import { uploadAudio } from "@/lib/studio/uploadAudio";
import type { ClipLoadState } from "@/lib/studio/useMixPreview";
import { formatDuration } from "@/lib/utils";
import { Section, Slider, Switch } from "./studio-ui";
import ConfirmButton from "@/components/ConfirmButton";

interface TracksStudioProps {
  videoId: string;
  mix: AudioMix;
  /** `mergeKey` groups a drag or slider move into one undo step. */
  onChange: (mix: AudioMix, mergeKey?: string) => void;
  editedDuration: number;
  /** Playhead on the edited timeline. */
  playhead: number;
  onSeek: (editedTime: number) => void;
  loads: Record<string, ClipLoadState>;
  getBuffer: (url: string) => AudioBuffer | undefined;
  onExtractOriginal: () => void;
  hasOriginalAudio: boolean;
}

const GAIN = { min: MIX_LIMITS.gainDb.min, max: MIX_LIMITS.gainDb.max, step: 0.5 };
const FADE = { min: 0, max: 10000, step: 50 };
const fmtDb = (v: number) => (v <= MIX_LIMITS.gainDb.min ? "Off" : `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`);
const fmtS = (v: number) => `${v.toFixed(2)} s`;
const fmtMs = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const clock = (t: number) => `${formatDuration(Math.floor(t)) || "0:00"}.${Math.floor((t % 1) * 10)}`;

interface Upload { id: string; trackId: string; name: string; fraction: number; controller: AbortController }

export default function TracksStudio({
  videoId, mix, onChange, editedDuration, playhead, onSeek, loads, getBuffer, onExtractOriginal, hasOriginalAudio,
}: TracksStudioProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingTrack = useRef<string | null>(null);
  const total = Math.max(editedDuration, mixEnd(mix), 1);
  const sel = selected ? findClip(mix, selected) : null;

  const pickFile = (trackId: string) => {
    pendingTrack.current = trackId;
    fileRef.current?.click();
  };

  const onFiles = async (files: FileList | null) => {
    const trackId = pendingTrack.current;
    if (!files || !trackId) return;
    setError(null);
    for (const file of Array.from(files)) {
      const up: Upload = { id: `${Date.now()}${file.name}`, trackId, name: file.name, fraction: 0, controller: new AbortController() };
      setUploads((u) => [...u, up]);
      try {
        const asset = await uploadAudio(videoId, file, (f) =>
          setUploads((u) => u.map((x) => (x.id === up.id ? { ...x, fraction: f } : x))), up.controller.signal);
        // Read the latest mix at completion: other edits may have happened meanwhile.
        onChange(addClip(latest.current, trackId, asset, playhead));
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) setError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploads((u) => u.filter((x) => x.id !== up.id));
      }
    }
  };
  const latest = useRef(mix);
  useEffect(() => { latest.current = mix; }, [mix]);

  const addTrackAndPick = (kind: TrackKind) => {
    const next = addTrack(mix, kind);
    if (next === mix) return;
    onChange(next);
    pickFile(next.tracks[next.tracks.length - 1].id);
  };

  return (
    <div className="cs ts">
      <input ref={fileRef} type="file" accept="audio/*,video/mp4,video/webm" multiple hidden
        onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />

      <section className="ts-original" aria-label="Original audio">
        <div className="ts-row">
          <strong>Original audio</strong>
          <span className="ts-tag">{hasOriginalAudio ? "follows your cuts" : "none in this video"}</span>
        </div>
        {hasOriginalAudio && (
          <>
            <Switch label="Mute (remove from the export)" checked={mix.original.muted}
              onChange={(v) => onChange({ ...mix, original: { ...mix.original, muted: v } })} />
            {!mix.original.muted && (
              <Slider label="Level" value={mix.original.gainDb} range={GAIN} format={fmtDb}
                onChange={(v) => onChange({ ...mix, original: { ...mix.original, gainDb: v } }, "orig")} />
            )}
            <div className="cs-actions">
              <button className="ed-btn" onClick={() => { onChange({ ...mix, original: { ...mix.original, muted: true } }); addTrackAndPick("voice"); }}
                title="Mute the recording's audio and add a new voiceover in its place">Replace…</button>
              <button className="ed-btn" onClick={onExtractOriginal} title="Download the recording's own audio, edited, without effects or added tracks">
                Extract (WAV)
              </button>
            </div>
          </>
        )}
      </section>

      <div className="cs-actions" role="group" aria-label="Add a track">
        {(["music", "voice", "sfx"] as const).map((k) => (
          <button key={k} className="ed-btn" disabled={mix.tracks.length >= MIX_LIMITS.maxTracks} onClick={() => addTrackAndPick(k)}>
            + {KIND_LABELS[k]}
          </button>
        ))}
      </div>
      {error && <p className="ex-error" role="alert">{error}</p>}

      {mix.tracks.length > 0 && (
        <div className="ts-lanes" style={{ ["--ts-playhead" as string]: `${(playhead / total) * 100}%` }}>
          <div className="ts-ruler" onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onSeek(Math.max(0, Math.min(total, ((e.clientX - r.left) / r.width) * total)));
          }}>
            <span>0:00</span><span>{clock(total / 2)}</span><span>{clock(total)}</span>
            <i className="ts-end" style={{ left: `${(editedDuration / total) * 100}%` }} title="End of the video" />
          </div>
          {mix.tracks.map((t) => (
            <div key={t.id} className={t.muted ? "ts-track is-muted" : "ts-track"}>
              <div className="ts-track-head">
                <input className="ts-name" value={t.name} aria-label="Track name" maxLength={60}
                  onChange={(e) => onChange(updateTrack(mix, t.id, { name: e.target.value }), `name:${t.id}`)} />
                <button type="button" className={t.muted ? "ts-mini is-on" : "ts-mini"} aria-pressed={t.muted}
                  onClick={() => onChange(updateTrack(mix, t.id, { muted: !t.muted }))}>{t.muted ? "Muted" : "Mute"}</button>
                <button type="button" className="ts-mini" onClick={() => pickFile(t.id)}>+ Audio</button>
                <ConfirmButton className="ts-mini is-danger" ariaLabel={`Delete ${t.name}`} skip={t.clips.length === 0}
                  question={`Delete ${t.clips.length} clip(s)? You can undo.`} confirmLabel="Delete"
                  onConfirm={() => onChange(removeTrack(mix, t.id))}>×</ConfirmButton>
              </div>
              <Slider label="Track level" value={t.gainDb} range={GAIN} format={fmtDb}
                onChange={(v) => onChange(updateTrack(mix, t.id, { gainDb: v }), `tg:${t.id}`)} />
              <div className="ts-lane">
                {t.clips.map((c) => (
                  <ClipBlock key={c.id} clip={c} total={total} selected={c.id === selected} load={loads[c.url]}
                    buffer={getBuffer(c.url)} onSelect={() => setSelected(c.id)}
                    onMove={(s) => onChange(moveClip(latest.current, c.id, s), `mv:${c.id}`)}
                    onTrim={(edge, s) => onChange(trimClip(latest.current, c.id, edge, s), `tr:${c.id}:${edge}`)} />
                ))}
                {uploads.filter((u) => u.trackId === t.id).map((u) => (
                  <div key={u.id} className="ts-upload" role="status">
                    Uploading {u.name}… {Math.round(u.fraction * 100)}%
                    <button type="button" onClick={() => u.controller.abort()}>Cancel</button>
                  </div>
                ))}
                {t.clips.length === 0 && !uploads.some((u) => u.trackId === t.id) && (
                  <button type="button" className="ts-empty" onClick={() => pickFile(t.id)}>Add an audio file</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {sel && (
        <ClipDetails key={sel.clip.id} clip={sel.clip} playhead={playhead}
          onPatch={(p, key) => onChange(updateClip(mix, sel.clip.id, p), key)}
          onStart={(s) => onChange(moveClip(mix, sel.clip.id, s), `mv:${sel.clip.id}`)}
          onSplit={() => onChange(splitClip(mix, sel.clip.id, playhead))}
          onDelete={() => { onChange(removeClip(mix, sel.clip.id)); setSelected(null); }} />
      )}

      <p className="ed-fine">
        Added audio sits on the edited timeline, so it doesn&apos;t move when you cut the recording. Files go to your
        Cloudinary storage ({MIX_LIMITS.maxUploadBytes / 1048576} MB max each); MP3, WAV, AAC/M4A, OGG/Opus and FLAC work
        where this browser can decode them.
      </p>
    </div>
  );
}

function ClipBlock({
  clip, total, selected, load, buffer, onSelect, onMove, onTrim,
}: {
  clip: AudioClip; total: number; selected: boolean; load?: ClipLoadState; buffer?: AudioBuffer;
  onSelect: () => void; onMove: (start: number) => void; onTrim: (edge: "left" | "right", t: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !buffer) return;
    const w = Math.max(1, Math.round(cv.clientWidth * (window.devicePixelRatio || 1)));
    const h = Math.max(1, Math.round(cv.clientHeight * (window.devicePixelRatio || 1)));
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const data = buffer.getChannelData(0);
    const a = Math.floor(clip.in * buffer.sampleRate), b = Math.min(data.length, Math.floor(clip.out * buffer.sampleRate));
    const per = Math.max(1, Math.floor((b - a) / w));
    ctx.fillStyle = getComputedStyle(cv).color;
    for (let x = 0; x < w; x++) {
      let peak = 0;
      const s = a + x * per;
      for (let i = s; i < Math.min(b, s + per); i += Math.max(1, per >> 6)) peak = Math.max(peak, Math.abs(data[i]));
      const bh = Math.max(1, peak * h);
      ctx.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }, [buffer, clip.in, clip.out]);

  const drag = (mode: "move" | "left" | "right") => (e: ReactPointerEvent) => {
    e.stopPropagation();
    onSelect();
    const lane = (e.currentTarget as HTMLElement).closest(".ts-lane") as HTMLElement;
    const pxPerS = lane.getBoundingClientRect().width / total;
    const x0 = e.clientX;
    const base = mode === "right" ? clipEnd(clip) : clip.start;
    const move = (ev: PointerEvent) => {
      const t = base + (ev.clientX - x0) / pxPerS;
      if (mode === "move") onMove(t); else onTrim(mode, t);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className={["ts-clip", selected && "is-selected", load === "error" && "is-error"].filter(Boolean).join(" ")}
      style={{ left: `${(clip.start / total) * 100}%`, width: `${(clipLength(clip) / total) * 100}%` }}
      onPointerDown={drag("move")}
      role="button" tabIndex={0} aria-label={`${clip.name}, ${fmtS(clip.start)} to ${fmtS(clipEnd(clip))}`}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); onMove(clip.start + (e.key === "ArrowLeft" ? -0.1 : 0.1)); }
        if (e.key === "Enter") onSelect();
      }}
      title={load === "error" ? "This file couldn't be loaded" : clip.name}
    >
      <canvas ref={canvas} aria-hidden />
      <span className="ts-clip-name">{load === "loading" ? "Loading…" : load === "error" ? "Can't load" : clip.name}</span>
      <i className="ts-handle is-left" onPointerDown={drag("left")} aria-hidden />
      <i className="ts-handle is-right" onPointerDown={drag("right")} aria-hidden />
    </div>
  );
}

function ClipDetails({
  clip, playhead, onPatch, onStart, onSplit, onDelete,
}: {
  clip: AudioClip; playhead: number;
  onPatch: (p: Partial<AudioClip>, key?: string) => void; onStart: (s: number) => void; onSplit: () => void; onDelete: () => void;
}) {
  const inside = playhead > clip.start + MIX_LIMITS.minClip && playhead < clipEnd(clip) - MIX_LIMITS.minClip;
  const startRange = useMemo(() => ({ min: 0, max: Math.max(clip.start + 60, 600), step: 0.01 }), [clip.start]);
  return (
    <Section defaultOpen title={`Clip: ${clip.name}`} summary={`${fmtS(clip.start)} → ${fmtS(clipEnd(clip))}`}>
      <div className="cs-actions">
        <button className="ed-btn" onClick={() => onStart(playhead)}>Move to playhead</button>
        <button className="ed-btn" onClick={onSplit} disabled={!inside} title="Split this clip at the playhead">Split</button>
        <button className="ed-btn is-danger" onClick={onDelete}>Delete clip</button>
      </div>
      <Slider label="Start" value={clip.start} range={startRange} format={fmtS} onChange={onStart}
        help="Where the clip begins in the finished video. Drag the clip on its lane, or use ←/→ when it's focused." />
      <Slider label="Clip level" value={clip.gainDb} range={GAIN} format={fmtDb} onChange={(v) => onPatch({ gainDb: v }, `cg:${clip.id}`)} />
      <Slider label="Fade in" value={clip.fadeInMs} range={FADE} format={fmtMs} onChange={(v) => onPatch({ fadeInMs: v }, `fi:${clip.id}`)} />
      <Slider label="Fade out" value={clip.fadeOutMs} range={FADE} format={fmtMs} onChange={(v) => onPatch({ fadeOutMs: v }, `fo:${clip.id}`)} />
      <p className="ed-fine">Plays {fmtS(clip.in)}–{fmtS(clip.out)} of the file ({fmtS(clip.assetDuration)} long). Drag the clip&apos;s edges to trim.</p>
    </Section>
  );
}
