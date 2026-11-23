"use client";

// Draws the editor's preview "stage" with the same renderers the export
// uses: the framed picture (aspect, fit, crop, colour) and the captions.
//
// When the framing changes nothing, the <video> shows itself and a
// transparent canvas laid exactly over its picture carries the captions
// (cheapest, and the picture stays native). Otherwise the canvas takes the
// output's shape and paints every frame from the video, which keeps playing
// underneath (invisible) for sound and decoding. Sizes and positions are
// fractions of the frame, so either way the preview matches the export.

import { useEffect, type RefObject } from "react";
import { sourceToEdited, type Range } from "@/lib/media/edl";
import { captionAt, type Caption, type CaptionStyle } from "./captions";
import { drawCaption, loadCaptionFont } from "./captionRender";
import { drawFrame, isIdentityLook, outputSize, type VideoLook } from "./frame";

export interface StageOptions {
  /** Captions on the timeline `merged` maps to (edited), or source time when merged is null. */
  captions: Caption[];
  style: CaptionStyle;
  merged: Range[] | null;
  showCaptions: boolean;
  look: VideoLook;
}

export function useStageRenderer(
  videoRef: RefObject<HTMLVideoElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
  { captions, style, merged, showCaptions, look }: StageOptions
) {
  useEffect(() => {
    const video = videoRef.current, canvas = canvasRef.current;
    if (!video || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const framed = !isIdentityLook(look);
    let raf = 0, alive = true;
    video.classList.toggle("is-behind-stage", framed);

    const fit = () => {
      const cw = video.clientWidth, ch = video.clientHeight;
      const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
      // The shape on screen: the output's when framed, else the picture's.
      const shape = framed ? outputSize(vw, vh, look, null) : { width: vw, height: vh };
      const s = Math.min(cw / shape.width, ch / shape.height);
      const w = shape.width * s, h = shape.height * s;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.style.left = `${video.offsetLeft + (cw - w) / 2}px`;
      canvas.style.top = `${video.offsetTop + (ch - h) / 2}px`;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
    };

    const draw = () => {
      const W = canvas.width, H = canvas.height;
      ctx.clearRect(0, 0, W, H);
      if (framed && video.readyState >= 2) {
        drawFrame(ctx, (c, sx, sy, sw, sh, dx, dy, dw, dh) => c.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh),
          video.videoWidth, video.videoHeight, look, W, H);
      }
      if (!showCaptions) return;
      const t = merged ? sourceToEdited(video.currentTime, merged) : video.currentTime;
      drawCaption(ctx, captionAt(captions, t), t, style, W, H);
    };

    const loop = () => {
      draw();
      if (alive && !video.paused) raf = requestAnimationFrame(loop);
    };
    const kick = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); };
    const refit = () => { fit(); draw(); };
    // A paused video may not have a drawable frame yet when its load events
    // fire (measured in Chrome: loadeddata at readyState 2 drew nothing), so
    // also redraw when the next frame is actually presented.
    type FrameCallbackVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void };
    const fv = video as FrameCallbackVideo;
    let vfc = 0;
    const drawWhenPresented = () => {
      draw();
      if (fv.requestVideoFrameCallback) {
        fv.cancelVideoFrameCallback?.(vfc);
        vfc = fv.requestVideoFrameCallback(() => { if (alive) draw(); });
      }
    };

    refit();
    if (framed && video.readyState >= 2) drawWhenPresented();
    if (!video.paused) kick();
    if (showCaptions) loadCaptionFont(style).then(() => { if (alive) draw(); });

    const ro = new ResizeObserver(refit);
    ro.observe(video);
    video.addEventListener("loadedmetadata", refit);
    video.addEventListener("loadeddata", drawWhenPresented);
    video.addEventListener("canplay", drawWhenPresented);
    video.addEventListener("play", kick);
    video.addEventListener("seeked", drawWhenPresented);
    video.addEventListener("timeupdate", draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      video.classList.remove("is-behind-stage");
      video.removeEventListener("loadedmetadata", refit);
      fv.cancelVideoFrameCallback?.(vfc);
      video.removeEventListener("loadeddata", drawWhenPresented);
      video.removeEventListener("canplay", drawWhenPresented);
      video.removeEventListener("play", kick);
      video.removeEventListener("seeked", drawWhenPresented);
      video.removeEventListener("timeupdate", draw);
    };
  }, [videoRef, canvasRef, captions, style, merged, showCaptions, look]);
}
