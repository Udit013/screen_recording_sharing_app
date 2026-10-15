"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { saveEdit, saveWordTranscript, type EditorData } from "@/lib/actions/edit";
import { useAudioAnalysis, type AnalysisState } from "@/lib/media/useAudioAnalysis";
import { useTranscriber } from "@/lib/media/useTranscriber";
import { historyReducer } from "@/lib/media/history";
import {
  clipSegments, keptSegments, mergeRanges, nextPlayableTime, isInsideCut, roundMs, sourceToEdited, subtractRange, summarizeEdit,
  type Cut, type Range,
} from "@/lib/media/edl";
import { PAUSE_LEVELS, pauseCuts, type PauseLevel } from "@/lib/media/pauses";
import { cutForWords, groupSentences, refineWords, wordCutMask, type Word } from "@/lib/media/align";
import { formatDuration } from "@/lib/utils";
import Timeline from "./Timeline";
import TranscriptPane, { type PauseMarker } from "./TranscriptPane";
import ExportDialog from "./ExportDialog";

type Ready = Extract<AnalysisState, { status: "ready" }>;
type LevelState = PauseLevel | "off" | "custom";

const LEVELS = Object.keys(PAUSE_LEVELS) as PauseLevel[];
/** Pauses shorter than this are only marked in the transcript once removed. */
const MARKER_MIN_PAUSE = 0.7;
/** Padding used when a single pause is removed by hand with no level active. */
const DEFAULT_PADDING = PAUSE_LEVELS.balanced.padding;

const clock = (t: number) => formatDuration(Math.floor(t)) || "0:00";
const secs = (t: number) => (t >= 60 ? clock(t) : `${t.toFixed(1)}s`);

/**
 * Which pause level the current silence cuts correspond to. Derived rather
 * than stored separately, so undo/redo can never leave the level control out
 * of sync with the actual cuts. A small tolerance absorbs decoder differences
 * between browsers when the audio is re-analysed on a later visit.
 */
function levelOf(cuts: Cut[], silences: Range[]): LevelState {
  const own = cuts.filter((c) => c.reason === "silence").sort((a, b) => a.start - b.start);
  if (own.length === 0) return "off";
  for (const level of LEVELS) {
    const expected = pauseCuts(silences, level);
    if (
      expected.length === own.length &&
      expected.every((c, i) => Math.abs(c.start - own[i].start) < 0.02 && Math.abs(c.end - own[i].end) < 0.02)
    ) {
      return level;
    }
  }
  return "custom";
}

export default function Editor({ data }: { data: EditorData }) {
  const analysis = useAudioAnalysis(data.videoUrl);

  // Progress 0 means not one byte has arrived. That is normal for a moment,
  // but past a few seconds it is almost always Cloudinary creating the audio
  // rendition on first use (measured: 15.9 s for a 10-minute video; stored
  // permanently after that), so say so instead of sitting silently at 0%.
  const waitingForFirstByte = analysis.status === "loading" && analysis.progress === 0;
  const [slowStart, setSlowStart] = useState(false);
  useEffect(() => {
    if (!waitingForFirstByte) {
      setSlowStart(false);
      return;
    }
    const timer = setTimeout(() => setSlowStart(true), 4000);
    return () => clearTimeout(timer);
  }, [waitingForFirstByte]);

  if (analysis.status !== "ready") {
    return (
      <div className="ed">
        <header className="ed-top">
          <Link href={`/video/${data.videoId}`} className="ed-back">← Back to video</Link>
          <div className="ed-title"><h1>{data.title}</h1></div>
        </header>
        <div className="ed-state">
          {analysis.status === "loading" ? (
            <>
              <p className="ed-state-title">Analysing the audio</p>
              <div className="ed-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100}
                aria-valuenow={analysis.progress === null ? undefined : Math.round(analysis.progress * 100)}>
                <div
                  className={analysis.progress === null ? "is-indeterminate" : undefined}
                  style={analysis.progress === null ? undefined : { width: `${analysis.progress * 100}%` }}
                />
              </div>
              <p className="ed-state-note">
                Downloading a compressed audio track
                {analysis.progress !== null && ` · ${Math.round(analysis.progress * 100)}%`}. Everything after this
                runs on your device.
              </p>
              {slowStart && (
                <p className="ed-state-wait" role="status">
                  Cloudinary is preparing this video&apos;s audio for the first time. Long recordings can take up
                  to a minute; it&apos;s instant every time after that.
                </p>
              )}
            </>
          ) : (
            <>
              <p className="ed-state-title">Couldn&apos;t load the audio</p>
              <p className="ed-state-note">{analysis.message}</p>
              <button className="ed-btn" onClick={() => window.location.reload()}>Try again</button>
            </>
          )}
        </div>
      </div>
    );
  }

  return <Workspace data={data} analysis={analysis} />;
}

function Workspace({ data, analysis }: { data: EditorData; analysis: Ready }) {
  const { audio, silences } = analysis;
  const duration = audio.duration;
  const videoRef = useRef<HTMLVideoElement>(null);

  // ── Edit state ──────────────────────────────────────────────────────────
  const [history, dispatch] = useReducer(historyReducer, data.cuts, (cuts) => ({ past: [], present: cuts, future: [] }));
  const cuts = history.present;
  const merged = useMemo(() => mergeRanges(cuts, duration), [cuts, duration]);
  const kept = useMemo(() => keptSegments(merged, duration), [merged, duration]);
  const summary = useMemo(() => summarizeEdit(merged, duration), [merged, duration]);
  const level = useMemo(() => levelOf(cuts, silences), [cuts, silences]);
  const commit = useCallback((next: Cut[]) => dispatch({ type: "commit", cuts: next }), []);

  // Seconds each level would remove on top of the manual cuts: measured on the
  // real edit, so the numbers on the buttons are exactly what you'd get.
  const levelSavings = useMemo(() => {
    const manual = cuts.filter((c) => c.reason === "manual");
    const base = summarizeEdit(mergeRanges(manual, duration), duration).removedSeconds;
    return Object.fromEntries(
      LEVELS.map((l) => [
        l,
        summarizeEdit(mergeRanges([...manual, ...pauseCuts(silences, l)], duration), duration).removedSeconds - base,
      ])
    ) as Record<PauseLevel, number>;
  }, [cuts, silences, duration]);

  const applyLevel = (next: PauseLevel | "off") => {
    const manual = cuts.filter((c) => c.reason !== "silence");
    commit(next === "off" ? manual : [...manual, ...pauseCuts(silences, next)]);
  };

  // ── Transcript ──────────────────────────────────────────────────────────
  const [words, setWords] = useState<Word[] | null>(data.words);
  const [wordsNote, setWordsNote] = useState<string | null>(null);
  const transcriber = useTranscriber();
  const tState = transcriber.state;
  const shownWords = useMemo<Word[]>(
    () => words ?? (tState.phase === "transcribing" ? tState.words : []),
    [words, tState]
  );
  const sentences = useMemo(() => groupSentences(shownWords), [shownWords]);
  const cutMask = useMemo(() => wordCutMask(shownWords, merged), [shownWords, merged]);

  useEffect(() => {
    if (tState.phase !== "done") return;
    // Whisper smears a sentence's last word across the pause after it; snap
    // word edges to the measured silences before anything is stored.
    const refined = refineWords(tState.words, silences);
    setWords(refined);
    const speed = tState.audioSeconds / (tState.inferenceMs / 1000);
    setWordsNote(`Transcribed ${refined.length} words at ${speed.toFixed(1)}× real time. Saving…`);
    saveWordTranscript(data.videoId, refined)
      .then((r) =>
        setWordsNote(
          `Transcribed ${r.wordCount} words at ${speed.toFixed(1)}× real time. Search, the transcript tab and AI chapters now use it.`
        )
      )
      .catch((err) => setWordsNote(`Transcript ready here but not saved: ${err instanceof Error ? err.message : "unknown error"}`));
  }, [tState, silences, data.videoId]);

  const pauseMarkers = useMemo<PauseMarker[]>(() => {
    if (shownWords.length === 0) return [];
    const out: PauseMarker[] = [];
    let w = 0;
    for (const p of silences) {
      while (w + 1 < shownWords.length && shownWords[w + 1].end <= p.start + 0.05) w++;
      if (shownWords[w].end > p.start + 0.05) continue; // before the first word
      const cut = isInsideCut((p.start + p.end) / 2, merged);
      if (cut || p.end - p.start >= MARKER_MIN_PAUSE) out.push({ after: w, start: p.start, end: p.end, cut });
    }
    return out;
  }, [shownWords, silences, merged]);

  const togglePause = useCallback(
    (p: PauseMarker) => {
      if (p.cut) {
        commit(subtractRange(cuts, p));
        return;
      }
      const pad = level === "off" || level === "custom" ? DEFAULT_PADDING : PAUSE_LEVELS[level].padding;
      const start = roundMs(p.start + pad), end = roundMs(p.end - pad);
      if (end - start > 0.05) commit([...cuts, { start, end, reason: "manual" }]);
    },
    [cuts, level, commit]
  );

  // ── Playback ────────────────────────────────────────────────────────────
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [mode, setMode] = useState<"edited" | "original">("edited");
  const mergedRef = useRef(merged);
  const modeRef = useRef(mode);
  useEffect(() => { mergedRef.current = merged; modeRef.current = mode; }, [merged, mode]);

  // Cuts are skipped in real time, so the preview is the edit without any
  // rendering. rAF rather than timeupdate: timeupdate fires every ~250 ms,
  // which would let a quarter second of removed audio leak through. But rAF
  // stops in a background tab while audio plays on, so timeupdate backs it up.
  const skipAndSync = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    let t = v.currentTime;
    if (modeRef.current === "edited" && !v.paused) {
      const next = nextPlayableTime(t, mergedRef.current);
      if (next !== t) {
        if (next >= duration - 0.05) v.pause();
        else v.currentTime = next;
        t = next;
      }
    }
    setCurrentTime(t);
  }, [duration]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      skipAndSync();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, skipAndSync]);

  const seek = useCallback((t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = t;
    setCurrentTime(t);
  }, []);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) return v.pause();
    let t = v.currentTime;
    if (t >= duration - 0.05) t = 0;
    if (modeRef.current === "edited") t = nextPlayableTime(t, mergedRef.current);
    if (t >= duration - 0.05) return; // everything after this point is cut
    if (t !== v.currentTime) v.currentTime = t;
    v.play().catch(() => {});
  }, [duration]);

  const activeIndex = useMemo(() => {
    let lo = 0, hi = shownWords.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (shownWords[mid].start <= currentTime) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found >= 0 && currentTime <= shownWords[found].end + 0.15 ? found : -1;
  }, [shownWords, currentTime]);

  // ── Selection ───────────────────────────────────────────────────────────
  const [wordSel, setWordSel] = useState<{ from: number; to: number } | null>(null);
  const [timeSel, setTimeSel] = useState<Range | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const up = () => { draggingRef.current = false; };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  const selRange = useMemo<Range | null>(() => {
    if (wordSel && shownWords.length) return cutForWords(shownWords, wordSel.from, wordSel.to);
    return timeSel;
  }, [wordSel, timeSel, shownWords]);

  const selFullyCut = useMemo(() => {
    if (!selRange) return false;
    if (wordSel) {
      const lo = Math.min(wordSel.from, wordSel.to), hi = Math.max(wordSel.from, wordSel.to);
      return cutMask.slice(lo, hi + 1).every(Boolean);
    }
    return merged.some((c) => c.start <= selRange.start + 0.01 && c.end >= selRange.end - 0.01);
  }, [selRange, wordSel, cutMask, merged]);

  const clearSelection = useCallback(() => { setWordSel(null); setTimeSel(null); }, []);

  const onWordDown = useCallback((i: number, extend: boolean) => {
    draggingRef.current = true;
    setTimeSel(null);
    setWordSel((s) => (extend && s ? { from: s.from, to: i } : { from: i, to: i }));
    if (!extend) seek(shownWords[i].start);
  }, [seek, shownWords]);

  const onWordEnter = useCallback((i: number) => {
    if (draggingRef.current) setWordSel((s) => (s ? { from: s.from, to: i } : { from: i, to: i }));
  }, []);

  const onTimelineSelect = useCallback((r: Range | null) => { setWordSel(null); setTimeSel(r); }, []);

  const cutSelection = useCallback(() => {
    if (!selRange || selRange.end - selRange.start < 0.01) return;
    const r = { start: roundMs(selRange.start), end: roundMs(selRange.end) };
    // Drop manual cuts the new one swallows, so repeated cuts don't pile up.
    const rest = cuts.filter((c) => !(c.reason === "manual" && c.start >= r.start && c.end <= r.end));
    commit([...rest, { ...r, reason: "manual" }]);
    clearSelection();
  }, [selRange, cuts, commit, clearSelection]);

  const restoreSelection = useCallback(() => {
    if (!selRange) return;
    commit(subtractRange(cuts, selRange));
    clearSelection();
  }, [selRange, cuts, commit, clearSelection]);

  // ── Autosave ────────────────────────────────────────────────────────────
  const [save, setSave] = useState<{ status: "saved" | "saving" | "error"; message?: string }>({ status: "saved" });
  const [retryTick, setRetryTick] = useState(0);
  const saveLevel = level === "off" || level === "custom" ? null : level;
  const sentKeyRef = useRef<string | null>(JSON.stringify([data.cuts, data.pauseLevel]));
  const seqRef = useRef(0);
  const inFlightRef = useRef(0);

  // The edit waiting for the debounce. Kept in a ref so leaving the editor
  // through an in-app link (which beforeunload never sees) can still send it.
  const pendingRef = useRef<{ key: string; cuts: Cut[]; level: PauseLevel | null } | null>(null);

  const sendPending = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    pendingRef.current = null;
    sentKeyRef.current = p.key;
    const seq = ++seqRef.current;
    inFlightRef.current++;
    saveEdit(data.videoId, p.cuts, p.level)
      .then(() => { if (seq === seqRef.current) setSave({ status: "saved" }); })
      .catch((err) => {
        if (seq !== seqRef.current) return;
        sentKeyRef.current = null;
        setSave({ status: "error", message: err instanceof Error ? err.message : "Save failed" });
      })
      .finally(() => { inFlightRef.current--; });
  }, [data.videoId]);

  useEffect(() => {
    const key = JSON.stringify([cuts, saveLevel]);
    if (key === sentKeyRef.current) {
      // e.g. an edit undone before it was sent: nothing new to store.
      pendingRef.current = null;
      if (inFlightRef.current === 0) setSave({ status: "saved" });
      return;
    }
    setSave({ status: "saving" });
    pendingRef.current = { key, cuts, level: saveLevel };
    const timer = setTimeout(sendPending, 700);
    return () => clearTimeout(timer);
  }, [cuts, saveLevel, retryTick, sendPending]);

  // Unmount (navigating away inside the app): send what the debounce held.
  useEffect(() => () => sendPending(), [sendPending]);

  useEffect(() => {
    if (save.status === "saved") return;
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [save.status]);

  // ── Export ──────────────────────────────────────────────────────────────
  // null = closed; otherwise the segments to render and what they are.
  const [exportJob, setExportJob] = useState<{ segments: Range[]; selection: boolean } | null>(null);
  const exportOpen = exportJob !== null;
  const openExport = useCallback((segments: Range[], selection: boolean) => {
    videoRef.current?.pause();
    setExportJob({ segments, selection });
  }, []);

  // ── Clips ───────────────────────────────────────────────────────────────
  const selectionKept = useMemo(() => (selRange ? clipSegments(kept, selRange) : []), [kept, selRange]);
  // copied: false means the clipboard was unavailable, so the link is shown
  // in a field to copy by hand rather than failing silently.
  const [clipLink, setClipLink] = useState<{ url: string; copied: boolean } | null>(null);
  useEffect(() => setClipLink(null), [selRange]);
  const copyClipLink = useCallback(() => {
    if (!selRange) return;
    // Source time, like ?t= links, so the link survives later re-edits.
    const r1 = (t: number) => Math.round(t * 10) / 10;
    const url = `${window.location.origin}/video/${data.videoId}?t=${r1(selRange.start)}&end=${r1(selRange.end)}`;
    const copy = navigator.clipboard?.writeText(url) ?? Promise.reject(new Error("no clipboard"));
    copy.then(() => setClipLink({ url, copied: true })).catch(() => setClipLink({ url, copied: false }));
  }, [selRange, data.videoId]);

  // ── Shortcut sheet ──────────────────────────────────────────────────────
  const [helpOpen, setHelpOpen] = useState(false);

  // ── Keyboard ────────────────────────────────────────────────────────────
  const keys = useRef({ togglePlay, cutSelection, restoreSelection, clearSelection, selFullyCut, exportOpen, helpOpen });
  useEffect(() => {
    keys.current = { togglePlay, cutSelection, restoreSelection, clearSelection, selFullyCut, exportOpen, helpOpen };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = keys.current;
      if (k.exportOpen) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable=true]")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? "redo" : "undo" });
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        dispatch({ type: "redo" });
      } else if (e.key === " " && !el.closest("button, a, [role=slider]")) {
        e.preventDefault();
        k.togglePlay();
      } else if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        if (k.selFullyCut) k.restoreSelection();
        else k.cutSelection();
      } else if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((o) => !o);
      } else if (e.key === "Escape") {
        if (k.helpOpen) setHelpOpen(false);
        else k.clearSelection();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────
  const shownTime = mode === "edited" ? sourceToEdited(currentTime, merged) : currentTime;
  const shownTotal = mode === "edited" ? summary.editedDuration : duration;
  const selWordCount = wordSel ? Math.abs(wordSel.to - wordSel.from) + 1 : 0;
  const transcribing = tState.phase === "model" || tState.phase === "transcribing";

  return (
    <div className="ed">
      <header className="ed-top">
        <Link href={`/video/${data.videoId}`} className="ed-back">← Back to video</Link>
        <div className="ed-title">
          <h1>{data.title}</h1>
          <span className={`ed-save is-${save.status}`} role="status">
            {save.status === "saving" && "Saving…"}
            {save.status === "saved" && "All changes saved"}
            {save.status === "error" && (
              <>
                Not saved: {save.message}{" "}
                <button className="ed-link" onClick={() => { sentKeyRef.current = null; setRetryTick((n) => n + 1); }}>
                  Retry
                </button>
              </>
            )}
          </span>
        </div>
        <div className="ed-actions">
          <button className="ed-icon" onClick={() => dispatch({ type: "undo" })} disabled={history.past.length === 0}
            aria-label="Undo" title="Undo (⌘Z)">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
          </button>
          <button className="ed-icon" onClick={() => dispatch({ type: "redo" })} disabled={history.future.length === 0}
            aria-label="Redo" title="Redo (⇧⌘Z)">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
          </button>
          <button className="ed-icon" onClick={() => setHelpOpen((o) => !o)} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"
            aria-expanded={helpOpen}>
            <span aria-hidden className="ed-icon-text">?</span>
          </button>
          <button className="ed-btn is-primary" onClick={() => openExport(kept, false)} disabled={kept.length === 0}>Export MP4</button>
        </div>
      </header>

      <div className="ed-main">
        <section className="ed-stage" aria-label="Preview">
          <div className="ed-video">
            <video
              ref={videoRef}
              src={data.videoUrl}
              // "metadata", not "auto": buffering the whole video up front
              // would compete with the analysis-audio download for bandwidth.
              // Playback buffers on demand.
              preload="metadata"
              playsInline
              onClick={togglePlay}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => setPlaying(false)}
              onTimeUpdate={skipAndSync}
              onSeeked={(e) => { if (e.currentTarget.paused) setCurrentTime(e.currentTarget.currentTime); }}
            />
            {mode === "edited" && isInsideCut(currentTime, merged) && !playing && (
              <span className="ed-video-flag">This moment is cut</span>
            )}
          </div>

          <div className="ed-transport">
            <button className="ed-play" onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
              {playing ? (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              )}
            </button>
            <span className="ed-clock">{clock(shownTime)} <span>/ {clock(shownTotal)}</span></span>
            <div className="ed-seg" role="radiogroup" aria-label="Preview mode">
              {(["edited", "original"] as const).map((m) => (
                <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "is-on" : undefined}
                  onClick={() => setMode(m)}>
                  {m === "edited" ? "Edited" : "Original"}
                </button>
              ))}
            </div>
          </div>

          <div className="ed-card ed-summary">
            <div><span>Original</span><strong>{clock(duration)}</strong></div>
            <div className="ed-summary-arrow" aria-hidden>→</div>
            <div><span>Edited</span><strong>{clock(summary.editedDuration)}</strong></div>
            <div className="ed-summary-saved">
              <span>Removed</span>
              <strong>{summary.removedSeconds > 0.05 ? `${secs(summary.removedSeconds)} · ${Math.round(summary.removedFraction * 100)}%` : "Nothing yet"}</strong>
            </div>
          </div>

          <div className="ed-card">
            <div className="ed-card-head">
              <h2>Tighten pauses</h2>
              {level === "custom" && <span className="ed-chip">Adjusted by hand</span>}
            </div>
            <div className="ed-levels" role="radiogroup" aria-label="Pause removal">
              <button role="radio" aria-checked={level === "off"} className={level === "off" ? "is-on" : undefined}
                onClick={() => applyLevel("off")}>
                <span>Off</span><small>Keep every pause</small>
              </button>
              {LEVELS.map((l) => (
                <button key={l} role="radio" aria-checked={level === l} className={level === l ? "is-on" : undefined}
                  onClick={() => applyLevel(l)} title={PAUSE_LEVELS[l].detail}>
                  <span>{PAUSE_LEVELS[l].label}</span>
                  <small>{levelSavings[l] > 0.05 ? `−${secs(levelSavings[l])}` : "No change"}</small>
                </button>
              ))}
            </div>
            <p className="ed-fine">
              {silences.length === 0
                ? "No clear pauses found: the background noise is too close to the speech level to separate them safely."
                : `${silences.length} pauses found against a ${analysis.noiseFloorDb.toFixed(0)} dB noise floor (speech ≈ ${analysis.speechLevelDb.toFixed(0)} dB), analysed in ${Math.max(1, Math.round(analysis.analysisMs))} ms.`}
            </p>
          </div>

          <p className="ed-fine ed-live-note">
            Edits apply to your video page and share link as soon as they&apos;re saved. The original upload is never
            modified, and every cut can be restored.
          </p>
        </section>

        <section className="ed-script" aria-label="Transcript">
          <div className="ed-script-head">
            {selRange ? (
              <div className="ed-selbar">
                <span>
                  {selWordCount > 0 ? `${selWordCount} ${selWordCount === 1 ? "word" : "words"}` : "Range"} ·{" "}
                  {secs(selRange.end - selRange.start)}
                </span>
                {selFullyCut ? (
                  <button className="ed-btn is-small" onClick={restoreSelection}>Restore <kbd>⌫</kbd></button>
                ) : (
                  <>
                    <button className="ed-btn is-small is-danger" onClick={cutSelection}>Cut <kbd>⌫</kbd></button>
                    <button className="ed-btn is-small" onClick={restoreSelection}>Restore</button>
                  </>
                )}
                {selectionKept.length > 0 && (
                  <>
                    <span className="ed-selbar-sep" aria-hidden />
                    <button className="ed-btn is-small" onClick={copyClipLink} title="Link that plays just this part">
                      {clipLink?.copied ? "Link copied" : "Copy clip link"}
                    </button>
                    <button className="ed-btn is-small" onClick={() => openExport(selectionKept, true)}>Export clip</button>
                  </>
                )}
                <button className="ed-link" onClick={clearSelection}>Clear</button>
                {clipLink && !clipLink.copied && (
                  <input
                    className="ed-clip-url"
                    readOnly
                    value={clipLink.url}
                    aria-label="Clip link (copy it manually)"
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                  />
                )}
              </div>
            ) : (
              <p className="ed-hint">
                {shownWords.length
                  ? "Select words, then press ⌫ to cut them. Shift-click extends a selection."
                  : "Drag across the timeline to select a range, then press ⌫ to cut it."}
              </p>
            )}
            {words && !transcribing && (
              <button className="ed-link" onClick={() => transcriber.start(audio, silences)}>Re-transcribe</button>
            )}
          </div>

          {tState.phase === "model" && (
            <Progress
              label="Downloading the speech model (cached after the first time)"
              fraction={tState.total ? tState.loaded / tState.total : null}
              detail={tState.total ? `${(tState.loaded / 1048576).toFixed(1)} / ${(tState.total / 1048576).toFixed(1)} MB` : undefined}
              onCancel={transcriber.cancel}
            />
          )}
          {tState.phase === "transcribing" && (
            <Progress
              label="Transcribing on this device"
              fraction={tState.done / tState.total}
              detail={`${tState.done} / ${tState.total} sections · ${tState.words.length} words`}
              onCancel={transcriber.cancel}
            />
          )}
          {tState.phase === "error" && (
            <div className="ed-callout is-error" role="alert">
              <p>Transcription failed: {tState.message}</p>
              <button className="ed-btn is-small" onClick={() => transcriber.start(audio, silences)}>Try again</button>
            </div>
          )}
          {wordsNote && tState.phase === "done" && <p className="ed-callout">{wordsNote}</p>}

          {shownWords.length > 0 ? (
            <TranscriptPane
              words={shownWords}
              sentences={sentences}
              cutMask={cutMask}
              activeIndex={activeIndex}
              selection={wordSel}
              pauses={pauseMarkers}
              onWordDown={onWordDown}
              onWordEnter={onWordEnter}
              onPauseClick={togglePause}
            />
          ) : (
            !transcribing && tState.phase !== "error" && (
              <div className="ed-empty">
                <h2>Edit by editing text</h2>
                <p>
                  Get a word-level transcript, then cut a sentence by deleting it. Speech recognition (Whisper) runs
                  entirely in your browser: your audio never leaves this device and it costs nothing.
                </p>
                <button className="ed-btn is-primary" onClick={() => transcriber.start(audio, silences)}>
                  Transcribe {clock(duration)} of audio
                </button>
                <p className="ed-fine">One-time model download, then cached by your browser.</p>
              </div>
            )
          )}
        </section>
      </div>

      <div className="ed-timeline">
        <Timeline
          samples={audio.samples}
          duration={duration}
          cuts={merged}
          pauses={silences}
          currentTime={currentTime}
          selection={selRange}
          onSeek={seek}
          onSelect={onTimelineSelect}
        />
        <div className="ed-legend" aria-hidden>
          <span><i className="is-wave" />Kept</span>
          <span><i className="is-cut" />Removed</span>
          <span><i className="is-pause" />Detected pause</span>
          <span className="ed-legend-keys"><kbd>Space</kbd> play · <kbd>⌫</kbd> cut/restore · <kbd>⌘Z</kbd> undo · <kbd>Esc</kbd> clear</span>
        </div>
      </div>

      {exportJob && (
        <ExportDialog
          videoUrl={data.videoUrl}
          title={data.title}
          segments={exportJob.segments}
          selection={exportJob.selection}
          editedSeconds={exportJob.segments.reduce((s, r) => s + (r.end - r.start), 0)}
          onClose={() => setExportJob(null)}
        />
      )}

      {helpOpen && (
        <div className="ed-help" role="dialog" aria-label="Keyboard shortcuts">
          <div className="ed-help-head">
            <h2>Keyboard shortcuts</h2>
            <button className="ed-link" onClick={() => setHelpOpen(false)}>Close</button>
          </div>
          <dl>
            {[
              ["Space", "Play / pause"],
              ["⌫  Delete", "Cut the selection, or restore it if it's already cut"],
              ["Shift-click", "Extend a word selection"],
              ["Drag", "Select words, or a range on the timeline"],
              ["← →", "Step 1 s (timeline focused)"],
              ["⌘Z  ⇧⌘Z", "Undo / redo"],
              ["Esc", "Clear the selection"],
              ["?", "Show or hide this list"],
            ].map(([k, v]) => (
              <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}

function Progress({
  label, fraction, detail, onCancel,
}: { label: string; fraction: number | null; detail?: string; onCancel: () => void }) {
  return (
    <div className="ed-callout">
      <div className="ed-callout-row">
        <p>{label}</p>
        <button className="ed-link" onClick={onCancel}>Cancel</button>
      </div>
      <div className="ed-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}>
        <div className={fraction === null ? "is-indeterminate" : undefined}
          style={fraction === null ? undefined : { width: `${fraction * 100}%` }} />
      </div>
      {detail && <p className="ed-fine">{detail}</p>}
    </div>
  );
}
