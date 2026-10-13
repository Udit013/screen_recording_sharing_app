"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import type { Sentence, Word } from "@/lib/media/align";
import { formatDuration } from "@/lib/utils";

export interface PauseMarker {
  /** Index of the word the pause follows. */
  after: number;
  start: number;
  end: number;
  cut: boolean;
}

interface TranscriptPaneProps {
  words: Word[];
  sentences: Sentence[];
  cutMask: boolean[];
  activeIndex: number;
  selection: { from: number; to: number } | null;
  pauses: PauseMarker[];
  onWordDown: (index: number, extend: boolean) => void;
  onWordEnter: (index: number) => void;
  onPauseClick: (pause: PauseMarker) => void;
}

export default function TranscriptPane(props: TranscriptPaneProps) {
  const { words, sentences, cutMask, activeIndex, selection, pauses } = props;
  // Both lists are sorted, so one linear walk assigns pauses to sentences.
  // Memoized: this component re-renders on every playback frame.
  const pausesBySentence = useMemo(() => {
    const map = new Map<number, PauseMarker[]>();
    let s = 0;
    for (const p of pauses) {
      while (s < sentences.length && sentences[s].to < p.after) s++;
      if (s === sentences.length) break;
      map.set(s, [...(map.get(s) ?? []), p]);
    }
    return map;
  }, [pauses, sentences]);
  const lo = selection ? Math.min(selection.from, selection.to) : -1;
  const hi = selection ? Math.max(selection.from, selection.to) : -1;

  return (
    <div className="tx" role="list" aria-label="Transcript — select words to cut them">
      {sentences.map((s, i) => (
        <SentenceRow
          key={s.from}
          sentence={s}
          words={words}
          maskKey={cutMask.slice(s.from, s.to + 1).map((c) => (c ? "1" : "0")).join("")}
          active={activeIndex >= s.from && activeIndex <= s.to ? activeIndex : -1}
          selFrom={hi < s.from || lo > s.to ? -1 : Math.max(lo, s.from)}
          selTo={hi < s.from || lo > s.to ? -1 : Math.min(hi, s.to)}
          pauses={pausesBySentence.get(i) ?? EMPTY}
          onWordDown={props.onWordDown}
          onWordEnter={props.onWordEnter}
          onPauseClick={props.onPauseClick}
        />
      ))}
    </div>
  );
}

const EMPTY: PauseMarker[] = [];

interface RowProps {
  sentence: Sentence;
  words: Word[];
  /** "0"/"1" per word in this sentence — a cheap, comparable memo key. */
  maskKey: string;
  active: number;
  selFrom: number;
  selTo: number;
  pauses: PauseMarker[];
  onWordDown: (index: number, extend: boolean) => void;
  onWordEnter: (index: number) => void;
  onPauseClick: (pause: PauseMarker) => void;
}

const SentenceRow = memo(function SentenceRow({
  sentence, words, maskKey, active, selFrom, selTo, pauses, onWordDown, onWordEnter, onPauseClick,
}: RowProps) {
  const rowRef = useRef<HTMLDivElement>(null);
  const allCut = !maskKey.includes("0");

  // Keep the spoken line in view during playback.
  useEffect(() => {
    if (active >= 0) rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [active >= 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const items: React.ReactNode[] = [];
  for (let i = sentence.from; i <= sentence.to; i++) {
    const cut = maskKey[i - sentence.from] === "1";
    const selected = selFrom >= 0 && i >= selFrom && i <= selTo;
    items.push(
      <span
        key={i}
        data-i={i}
        className={[
          "tx-word",
          cut && "is-cut",
          selected && "is-selected",
          i === active && "is-active",
        ].filter(Boolean).join(" ")}
        onPointerDown={(e) => { e.preventDefault(); onWordDown(i, e.shiftKey); }}
        onPointerEnter={(e) => { if (e.buttons === 1) onWordEnter(i); }}
      >
        {words[i].text}
      </span>
    );
    const pause = pauses.find((p) => p.after === i);
    if (pause) {
      items.push(
        <button
          key={`p${i}`}
          type="button"
          className={pause.cut ? "tx-pause is-cut" : "tx-pause"}
          title={pause.cut ? "Pause removed: click to keep it" : "Pause kept: click to remove it"}
          aria-pressed={pause.cut}
          onClick={() => onPauseClick(pause)}
        >
          {(pause.end - pause.start).toFixed(1)}s
        </button>
      );
    }
  }

  return (
    <div ref={rowRef} role="listitem" className={allCut ? "tx-row is-cut" : "tx-row"}>
      <span className="tx-time">{formatDuration(Math.floor(sentence.start)) || "0:00"}</span>
      <p className="tx-text">{items}</p>
    </div>
  );
});
