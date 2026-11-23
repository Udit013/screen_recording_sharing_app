"use client";

// Plays the added audio tracks in the editor preview, in sync with the video.
//
// Each clip's file is fetched and decoded once (cached by URL for the whole
// session) and played with an AudioBufferSourceNode through its own gain node,
// whose automation follows the same clip gain and fades as the export mixer
// (clipGainAt in tracks.ts). Everything feeds the preview's master bus, so
// the Audio tab's fades apply to the whole mix, as they do in the export.
//
// Scheduling: on play, seek or any change to the mix, everything is stopped
// and rescheduled from the current edited-timeline position. While playing,
// the position the audio clock implies is checked against the video several
// times a second, and drift beyond 60 ms triggers a reschedule.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { clipEnd, clipGainAt, clipLength, dbToGain, type AudioClip, type AudioMix } from "./tracks";

export type ClipLoadState = "loading" | "ready" | "error";

const bufferCache = new Map<string, Promise<AudioBuffer>>();

function loadBuffer(ctx: BaseAudioContext, url: string): Promise<AudioBuffer> {
  let p = bufferCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => ctx.decodeAudioData(b));
    p.catch(() => bufferCache.delete(url));
    bufferCache.set(url, p);
  }
  return p;
}

interface Bus { ctx: AudioContext; master: AudioNode }

export function useMixPreview(
  videoRef: RefObject<HTMLVideoElement | null>,
  getBus: () => Bus | null,
  ctxReady: number,
  mix: AudioMix,
  /** Edited-timeline position of the video right now, or null when added tracks shouldn't play (e.g. "Original" mode). */
  editedNow: () => number | null
) {
  const [loads, setLoads] = useState<Record<string, ClipLoadState>>({});
  const buffers = useRef(new Map<string, AudioBuffer>());
  const playing = useRef<{ src: AudioBufferSourceNode; gain: GainNode }[]>([]);
  const anchor = useRef<{ ctxTime: number; t: number } | null>(null);
  const mixRef = useRef(mix);
  const nowRef = useRef(editedNow);
  useEffect(() => { mixRef.current = mix; nowRef.current = editedNow; });

  const stopAll = useCallback(() => {
    for (const { src, gain } of playing.current) {
      try { src.stop(); } catch { /* already stopped */ }
      src.disconnect();
      gain.disconnect();
    }
    playing.current = [];
    anchor.current = null;
  }, []);

  const schedule = useCallback(() => {
    stopAll();
    const bus = getBus();
    const video = videoRef.current;
    const t = nowRef.current();
    // A suspended context has a frozen clock: nothing can be scheduled
    // against it. The preview resumes it on the next user gesture.
    if (!bus || !video || video.paused || t === null || bus.ctx.state !== "running") return;
    const { ctx, master } = bus;
    const lead = 0.03; // schedule slightly ahead so the first samples aren't late
    const when0 = ctx.currentTime + lead;
    const tAt = t + lead;
    anchor.current = { ctxTime: when0, t: tAt };
    for (const track of mixRef.current.tracks) {
      if (track.muted) continue;
      const tg = dbToGain(track.gainDb);
      if (tg === 0) continue;
      for (const c of track.clips) {
        if (clipEnd(c) <= tAt) continue;
        const buf = buffers.current.get(c.url);
        if (!buf) continue;
        const offsetInClip = Math.max(0, tAt - c.start);
        const when = when0 + Math.max(0, c.start - tAt);
        const dur = clipLength(c) - offsetInClip;
        if (dur <= 0) continue;
        const gain = ctx.createGain();
        automate(gain.gain, c, tg, when, offsetInClip, dur);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(gain).connect(master);
        src.start(when, c.in + offsetInClip, dur);
        playing.current.push({ src, gain });
      }
    }
  }, [getBus, stopAll, videoRef]);

  // Fetch and decode every clip's file (once per URL).
  useEffect(() => {
    const bus = getBus();
    const urls = [...new Set(mix.tracks.flatMap((t) => t.clips.map((c) => c.url)))];
    // Decoding needs a context; before the preview starts, use a throwaway one.
    const ctx: BaseAudioContext | null = bus?.ctx ?? (typeof OfflineAudioContext !== "undefined" ? new OfflineAudioContext(2, 1, 48000) : null);
    if (!ctx) return;
    let alive = true;
    for (const url of urls) {
      if (buffers.current.has(url)) continue;
      setLoads((s) => (s[url] ? s : { ...s, [url]: "loading" }));
      loadBuffer(ctx, url)
        .then((b) => {
          buffers.current.set(url, b);
          if (!alive) return;
          setLoads((s) => ({ ...s, [url]: "ready" }));
          schedule();
        })
        .catch(() => { if (alive) setLoads((s) => ({ ...s, [url]: "error" })); });
    }
    return () => { alive = false; };
  }, [mix, getBus, ctxReady, schedule]);

  // When the context starts running (first gesture), schedule what's due.
  useEffect(() => {
    const bus = getBus();
    if (!bus) return;
    const on = () => schedule();
    bus.ctx.addEventListener("statechange", on);
    return () => bus.ctx.removeEventListener("statechange", on);
  }, [getBus, ctxReady, schedule]);

  // Reschedule on any mix change, and on play/pause/seek.
  useEffect(() => { schedule(); }, [mix, ctxReady, schedule]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPause = () => stopAll();
    const check = () => {
      const a = anchor.current, bus = getBus(), t = nowRef.current();
      if (v.paused || !bus || t === null || bus.ctx.state !== "running") return;
      if (!a) { schedule(); return; }
      const expected = a.t + (bus.ctx.currentTime - a.ctxTime);
      if (Math.abs(expected - t) > 0.06) schedule();
    };
    v.addEventListener("play", schedule);
    v.addEventListener("playing", schedule);
    v.addEventListener("seeked", schedule);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onPause);
    const timer = window.setInterval(check, 200);
    return () => {
      v.removeEventListener("play", schedule);
      v.removeEventListener("playing", schedule);
      v.removeEventListener("seeked", schedule);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onPause);
      window.clearInterval(timer);
      stopAll();
    };
  }, [videoRef, schedule, stopAll, getBus]);

  const getBuffer = useCallback((url: string) => buffers.current.get(url), []);
  return { loads, reschedule: schedule, getBuffer };
}

/**
 * Gain automation for one scheduled clip: clip gain × track gain, with the
 * same linear fades as clipGainAt (sampled at the fade's start and end).
 */
function automate(param: AudioParam, c: AudioClip, trackGain: number, when: number, offset: number, dur: number) {
  const at = (local: number) => trackGain * clipGainAt(c, c.start + Math.min(local, clipLength(c) - 1e-6));
  const points = new Set<number>([offset]);
  const fi = c.fadeInMs / 1000, fo = c.fadeOutMs / 1000, len = clipLength(c);
  if (fi > 0 && fi > offset) points.add(fi);
  if (fo > 0 && len - fo > offset) points.add(len - fo);
  points.add(offset + dur);
  const sorted = [...points].sort((a, b) => a - b);
  param.setValueAtTime(at(sorted[0]), when);
  for (const p of sorted.slice(1)) param.linearRampToValueAtTime(at(p), when + (p - offset));
}
