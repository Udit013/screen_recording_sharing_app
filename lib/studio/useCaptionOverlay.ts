"use client";

// Draws the caption track over the editor's <video> with the same renderer
// the export uses. The canvas is laid exactly over the video's picture (not
// its letterbox), at device resolution, so sizes and positions, which are
// fractions of the frame, match the exported file.

import { useEffect, type RefObject } from "react";
import { sourceToEdited, type Range } from "@/lib/media/edl";
import { captionAt, type Caption, type CaptionStyle } from "./captions";
import { drawCaption, loadCaptionFont } from "./captionRender";

export function useCaptionOverlay(
  videoRef: RefObject<HTMLVideoElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  /** Captions on the timeline `timeOf` returns. */
  captions: Caption[],
  style: CaptionStyle,
  /** Merged cuts when previewing the edit (captions are on the edited timeline), else null. */
  merged: Range[] | null,
  visible: boolean
) {
  useEffect(() => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0, alive = true;

    const fit = () => {
      // The picture's rectangle inside the element (object-fit: contain).
      const cw = video.clientWidth, ch = video.clientHeight;
      const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
      const s = Math.min(cw / vw, ch / vh);
      const w = vw * s, h = vh * s;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.style.left = `${video.offsetLeft + (cw - w) / 2}px`;
      canvas.style.top = `${video.offsetTop + (ch - h) / 2}px`;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    };

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!visible) return;
      const t = merged ? sourceToEdited(video.currentTime, merged) : video.currentTime;
      drawCaption(ctx, captionAt(captions, t), t, style, canvas.width, canvas.height);
    };

    const loop = () => {
      draw();
      if (alive && !video.paused) raf = requestAnimationFrame(loop);
    };
    const kick = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); };

    fit();
    draw();
    if (!video.paused) kick();
    loadCaptionFont(style).then(() => { if (alive) draw(); });

    const ro = new ResizeObserver(() => { fit(); draw(); });
    ro.observe(video);
    const onMeta = () => { fit(); draw(); };
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("play", kick);
    video.addEventListener("seeked", draw);
    video.addEventListener("timeupdate", draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("play", kick);
      video.removeEventListener("seeked", draw);
      video.removeEventListener("timeupdate", draw);
    };
  }, [videoRef, canvasRef, captions, style, merged, visible]);
}
