"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { computePeaks } from "@/lib/media/silence";
import type { Range } from "@/lib/media/edl";
import { formatDuration } from "@/lib/utils";

interface TimelineProps {
  samples: Float32Array;
  duration: number;
  /** Merged cuts (source time). */
  cuts: Range[];
  /** Detected pauses (source time), drawn as a faint band. */
  pauses: Range[];
  currentTime: number;
  selection: Range | null;
  onSeek: (t: number) => void;
  onSelect: (r: Range | null) => void;
}

const HEIGHT = 96;

/**
 * Waveform timeline. The waveform and cut overlays redraw only when the data
 * or size changes; the playhead is a separate absolutely-positioned element so
 * playback doesn't repaint the canvas 60 times a second.
 */
export default function Timeline({
  samples, duration, cuts, pauses, currentTime, selection, onSeek, onSelect,
}: TimelineProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const dragRef = useRef<{ anchor: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
  // Peaks depend only on audio + pixel width, not on edits.
  const peaks = useMemo(
    () => (width > 0 ? computePeaks(samples, Math.floor(width * dpr)) : null),
    [samples, width, dpr]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || width === 0) return;
    const W = Math.floor(width * dpr);
    const H = HEIGHT * dpr;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const css = getComputedStyle(canvas);
    const wave = css.getPropertyValue("--tl-wave").trim() || "#2c325d";
    const waveCut = css.getPropertyValue("--tl-wave-cut").trim() || "#c9c4d3";
    const pauseBand = css.getPropertyValue("--tl-pause").trim() || "rgba(108,102,133,0.08)";
    const cutFill = css.getPropertyValue("--tl-cut").trim() || "rgba(255,67,147,0.12)";
    const x = (t: number) => (t / duration) * W;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = pauseBand;
    for (const p of pauses) ctx.fillRect(x(p.start), 0, Math.max(1, x(p.end) - x(p.start)), H);

    // Waveform: kept audio in ink, removed audio faded.
    const mid = H / 2;
    let ci = 0;
    for (let i = 0; i < W; i++) {
      const t = (i / W) * duration;
      while (ci < cuts.length && cuts[ci].end <= t) ci++;
      const inCut = ci < cuts.length && t >= cuts[ci].start;
      const min = peaks[i * 2], max = peaks[i * 2 + 1];
      ctx.fillStyle = inCut ? waveCut : wave;
      const top = mid - Math.max(0.5, max * mid * 0.95);
      const bottom = mid - Math.min(-0.5, min * mid * 0.95);
      ctx.fillRect(i, top, 1, bottom - top);
    }

    // Cut regions: tint plus hatching, so "removed" reads at a glance.
    for (const c of cuts) {
      const x0 = x(c.start), w = Math.max(1, x(c.end) - x0);
      ctx.fillStyle = cutFill;
      ctx.fillRect(x0, 0, w, H);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, w, H);
      ctx.clip();
      ctx.strokeStyle = cutFill;
      ctx.lineWidth = dpr;
      for (let k = -H; k < w + H; k += 7 * dpr) {
        ctx.beginPath();
        ctx.moveTo(x0 + k, H);
        ctx.lineTo(x0 + k + H, 0);
        ctx.stroke();
      }
      ctx.restore();
    }
  }, [peaks, cuts, pauses, duration, width, dpr]);

  const timeAt = useCallback(
    (clientX: number) => {
      const rect = wrapRef.current!.getBoundingClientRect();
      return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
    },
    [duration]
  );

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { anchor: timeAt(e.clientX), moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const t = timeAt(e.clientX);
    setHover(t);
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.abs(t - drag.anchor) > duration * 0.002) drag.moved = true;
    if (drag.moved) onSelect({ start: Math.min(drag.anchor, t), end: Math.max(drag.anchor, t) });
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && !drag.moved) {
      onSelect(null);
      onSeek(timeAt(e.clientX));
    }
  };

  const pct = (t: number) => `${(t / duration) * 100}%`;

  return (
    <div className="tl" aria-label="Timeline">
      <div
        ref={wrapRef}
        className="tl-track"
        role="slider"
        tabIndex={0}
        aria-label="Seek timeline (drag to select a range)"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={formatDuration(Math.floor(currentTime)) || "0:00"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") { e.preventDefault(); onSeek(Math.max(0, currentTime - 1)); }
          if (e.key === "ArrowRight") { e.preventDefault(); onSeek(Math.min(duration, currentTime + 1)); }
        }}
      >
        <canvas ref={canvasRef} className="tl-canvas" style={{ height: HEIGHT }} />
        {selection && (
          <div className="tl-selection" style={{ left: pct(selection.start), width: pct(selection.end - selection.start) }} />
        )}
        <div className="tl-playhead" style={{ left: pct(currentTime) }} />
        {hover !== null && (
          <div className="tl-hover" style={{ left: pct(hover) }}>
            {formatDuration(Math.floor(hover)) || "0:00"}
          </div>
        )}
      </div>
      <div className="tl-scale">
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <span key={f}>{formatDuration(Math.floor(duration * f)) || "0:00"}</span>
        ))}
      </div>
    </div>
  );
}
