"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AudioFx } from "./fx";
export { fadeGainAt } from "./fx";
import { FX_PROCESSOR, fxWorkletUrl, type FxMeterMessage, type FxPortMessage } from "./worklet";

export type PreviewFxStatus =
  | { state: "idle" } // not started yet: starts on the first play (a user gesture)
  | { state: "starting" }
  | { state: "live" }
  | { state: "unavailable"; reason: string };

export interface PreviewMeter {
  inPeak: number;
  outPeak: number;
  reductionDb: number;
}

/**
 * Routes the editor's <video> through the effects worklet:
 *   <video> → MediaElementSource → worklet (effects) → fade gain → speakers
 *
 * The AudioContext is created lazily from start() (call it inside the play
 * handler: browsers only allow audio to start from a user gesture). If any
 * step fails, the video keeps playing its original audio and the status says
 * why; nothing is half-connected.
 *
 * The <video> must have crossOrigin="anonymous": a cross-origin element routed
 * into Web Audio otherwise outputs silence. Cloudinary serves CORS headers.
 */
export function usePreviewFx(videoRef: RefObject<HTMLVideoElement | null>, fx: AudioFx, bypass: boolean) {
  const [status, setStatus] = useState<PreviewFxStatus>({ state: "idle" });
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const fadeRef = useRef<GainNode | null>(null);
  const startingRef = useRef<Promise<void> | null>(null);
  const meterRef = useRef<PreviewMeter>({ inPeak: 0, outPeak: 0, reductionDb: 0 });
  const fxRef = useRef(fx);
  const bypassRef = useRef(bypass);

  useEffect(() => {
    fxRef.current = fx;
    nodeRef.current?.port.postMessage({ type: "configure", fx } satisfies FxPortMessage);
  }, [fx]);

  useEffect(() => {
    bypassRef.current = bypass;
    nodeRef.current?.port.postMessage({ type: "bypass", value: bypass } satisfies FxPortMessage);
  }, [bypass]);

  const start = useCallback(async () => {
    if (ctxRef.current) {
      if (ctxRef.current.state === "suspended") await ctxRef.current.resume().catch(() => {});
      return;
    }
    if (startingRef.current) return startingRef.current;
    const video = videoRef.current;
    if (!video) return;

    startingRef.current = (async () => {
      setStatus({ state: "starting" });
      let ctx: AudioContext | null = null;
      try {
        if (typeof AudioWorkletNode === "undefined") throw new Error("This browser doesn't support AudioWorklet.");
        ctx = new AudioContext({ latencyHint: "interactive" });
        await ctx.audioWorklet.addModule(fxWorkletUrl());
        const node = new AudioWorkletNode(ctx, FX_PROCESSOR, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
        });
        node.port.onmessage = (e: MessageEvent<FxMeterMessage>) => {
          if (e.data.type === "meter") meterRef.current = e.data;
        };
        const fade = ctx.createGain();
        // Only now take over the element's audio: everything above succeeded.
        const source = ctx.createMediaElementSource(video);
        source.connect(node).connect(fade).connect(ctx.destination);
        node.port.postMessage({ type: "configure", fx: fxRef.current } satisfies FxPortMessage);
        node.port.postMessage({ type: "bypass", value: bypassRef.current } satisfies FxPortMessage);
        ctxRef.current = ctx;
        nodeRef.current = node;
        fadeRef.current = fade;
        if (ctx.state === "suspended") {
          // resume() can stay pending if the browser didn't count this as a
          // user gesture. Don't hang playback on it: retry on the next
          // interaction instead.
          await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
          if ((ctx.state as AudioContextState) !== "running") {
            const live = ctx;
            const retry = () => void live.resume().then(() => setStatus({ state: "live" }));
            document.addEventListener("pointerdown", retry, { once: true });
            document.addEventListener("keydown", retry, { once: true });
            setStatus({ state: "starting" });
            return;
          }
        }
        setStatus({ state: "live" });
      } catch (err) {
        await ctx?.close().catch(() => {});
        setStatus({ state: "unavailable", reason: err instanceof Error ? err.message : "Audio preview unavailable." });
      } finally {
        startingRef.current = null;
      }
    })();
    return startingRef.current;
  }, [videoRef]);

  /** Timeline gain for fades, eased to avoid clicks. */
  const setFadeGain = useCallback((gain: number) => {
    const ctx = ctxRef.current, fade = fadeRef.current;
    if (!ctx || !fade) return;
    fade.gain.setTargetAtTime(Math.max(0, Math.min(1, gain)), ctx.currentTime, 0.015);
  }, []);

  /** Clears reverb/delay tails, e.g. after a seek. */
  const resetTails = useCallback(
    () => nodeRef.current?.port.postMessage({ type: "reset" } satisfies FxPortMessage),
    []
  );

  useEffect(() => {
    return () => {
      nodeRef.current?.port.close();
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
      nodeRef.current = null;
      fadeRef.current = null;
    };
  }, []);

  return { status, start, setFadeGain, resetTails, meterRef };
}
