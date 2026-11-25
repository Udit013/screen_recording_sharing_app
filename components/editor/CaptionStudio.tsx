"use client";

// The Captions tab: generate captions from the word transcript, edit, split,
// merge, retime and delete them, style them with a template, and download
// SRT/WebVTT. Captions are stored in source time; everything shown here is on
// the edited timeline, so removing a pause or a sentence moves or drops the
// captions with it.

import { useMemo } from "react";
import type { Word } from "@/lib/media/align";
import type { Range } from "@/lib/media/edl";
import { formatDuration } from "@/lib/utils";
import {
  addCaption, CAPTION_TEMPLATES, captionsFromWords, mergeCaptions, retimeCaption, sanitizeCaptionStyle, setCaptionText,
  splitCaption, toEditedCaptions, toSrt, toVtt, type Caption, type CaptionStyle, type CaptionTrack,
} from "@/lib/studio/captions";
import { Section, Slider, Switch } from "./studio-ui";
import ConfirmButton from "@/components/ConfirmButton";

interface CaptionStudioProps {
  track: CaptionTrack;
  /** `mergeKey` groups typing or a slider drag into one undo step. */
  onChange: (track: CaptionTrack, mergeKey?: string) => void;
  words: Word[];
  merged: Range[];
  duration: number;
  /** Playhead, in source time. */
  currentTime: number;
  onSeek: (sourceTime: number) => void;
  title: string;
  onOpenTranscript: () => void;
}

const NUDGE = 0.05;
const FONT_LABELS: Record<CaptionStyle["font"], string> = { inter: "Inter", montserrat: "Montserrat", bebas: "Bebas Neue" };
const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
const stamp = (t: number) => {
  const tenths = Math.round(t * 10);
  return `${formatDuration(Math.floor(tenths / 10)) || "0:00"}.${tenths % 10}`;
};

export default function CaptionStudio({
  track, onChange, words, merged, duration, currentTime, onSeek, title, onOpenTranscript,
}: CaptionStudioProps) {
  const { captions, style } = track;
  const edited = useMemo(() => toEditedCaptions(captions, merged), [captions, merged]);
  const editedById = useMemo(() => new Map(edited.map((c) => [c.id, c])), [edited]);
  const activeId = useMemo(() => captions.find((c) => currentTime >= c.start && currentTime < c.end)?.id ?? null, [captions, currentTime]);

  const setCaptions = (next: Caption[], mergeKey?: string) => onChange({ ...track, captions: next }, mergeKey);
  const setStyle = (patch: Partial<CaptionStyle>, mergeKey?: string) =>
    onChange({ ...track, style: sanitizeCaptionStyle({ ...style, ...patch }) }, mergeKey ? `style:${mergeKey}` : undefined);
  const replaceAt = (i: number, items: Caption[]) => setCaptions([...captions.slice(0, i), ...items, ...captions.slice(i + 1)]);

  const generate = () => {
    setCaptions(captionsFromWords(words, { maxWords: Math.max(3, style.maxWordsPerLine * style.maxLines) }));
  };

  const download = (kind: "srt" | "vtt") => {
    const body = kind === "srt" ? toSrt(edited) : toVtt(edited);
    const blob = new Blob([body], { type: kind === "srt" ? "application/x-subrip" : "text/vtt" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${title.replace(/[^\w\- ]+/g, "").trim() || "captions"}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  if (captions.length === 0) {
    return (
      <div className="cs">
        <div className="ed-empty">
          {words.length > 0 ? (
            <>
              <p>Turn the transcript into captions. They follow your cuts automatically and can be burned into the export or downloaded as SRT/VTT.</p>
              <button className="ed-btn is-primary" onClick={generate}>Generate captions</button>
            </>
          ) : (
            <>
              <p>Captions are built from the word-level transcript. Transcribe the video first. It runs in your browser for free.</p>
              <button className="ed-btn is-primary" onClick={onOpenTranscript}>Go to Transcript</button>
            </>
          )}
          <button className="ed-btn" onClick={() => setCaptions(addCaption(captions, currentTime, duration))}>
            Add a caption at the playhead
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cs">
      <div className="as-master">
        <Switch
          label="Burn captions into the export"
          checked={track.burnIn}
          onChange={(v) => onChange({ ...track, burnIn: v })}
          help="Draws the captions onto the exported video, exactly as in the preview. Turn off to export clean video and use the SRT/VTT files instead."
        />
      </div>

      <div className="cs-actions">
        <button className="ed-btn" onClick={() => setCaptions(addCaption(captions, currentTime, duration))}
          title="Adds a caption at the playhead, if there's room">+ Caption</button>
        <ConfirmButton className="ed-btn" onConfirm={generate} disabled={words.length === 0} skip={captions.length === 0}
          question="Replace all captions? You can undo." confirmLabel="Replace">Regenerate</ConfirmButton>
        <button className="ed-btn" onClick={() => download("srt")} disabled={edited.length === 0}>SRT</button>
        <button className="ed-btn" onClick={() => download("vtt")} disabled={edited.length === 0}>VTT</button>
      </div>

      <fieldset className="cs-templates">
        <legend>Style</legend>
        {CAPTION_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={style.template === t.id ? "cs-tpl is-on" : "cs-tpl"}
            aria-pressed={style.template === t.id}
            title={t.description}
            onClick={() => onChange({ ...track, style: { ...t.style } })}
          >
            <span className={`cs-tpl-sample is-${t.id}`} aria-hidden>Aa</span>
            {t.label}
          </button>
        ))}
      </fieldset>

      <div className="as-sections">
        <Section title="Text" summary={`${FONT_LABELS[style.font]} · ${(style.size * 100).toFixed(1)}%`}>
          <div className="as-row">
            <label htmlFor="cs-font">Font</label>
            <select id="cs-font" className="as-select" value={style.font}
              onChange={(e) => setStyle({ font: e.target.value as CaptionStyle["font"] })}>
              {Object.entries(FONT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          {style.font !== "bebas" && (
            <div className="as-row">
              <label htmlFor="cs-weight">Weight</label>
              <select id="cs-weight" className="as-select" value={style.weight}
                onChange={(e) => setStyle({ weight: Number(e.target.value) as CaptionStyle["weight"] })}>
                {[400, 600, 700, 800, 900].map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
          )}
          <Slider label="Size" value={style.size} range={{ min: 0.02, max: 0.16, step: 0.002 }}
            format={(v) => `${(v * 100).toFixed(1)}% of height`} onChange={(v) => setStyle({ size: v }, "size")} />
          <Switch label="Uppercase" checked={style.uppercase} onChange={(v) => setStyle({ uppercase: v })} />
          <ColorRow label="Text colour" value={style.color} onChange={(v) => setStyle({ color: v }, "color")} />
          <ColorRow label="Active word" value={style.highlight} onChange={(v) => setStyle({ highlight: v }, "highlight")} />
        </Section>

        <Section title="Position" summary={`${Math.round(style.y * 100)}% down`}>
          <Slider label="Vertical" value={style.y} range={{ min: 0, max: 1, step: 0.01 }} format={fmtPct}
            onChange={(v) => setStyle({ y: v }, "y")} help="Centre of the caption block. It is always kept inside the safe margin." />
          <Slider label="Horizontal" value={style.x} range={{ min: 0, max: 1, step: 0.01 }} format={fmtPct}
            onChange={(v) => setStyle({ x: v }, "x")} />
          <div className="as-row">
            <label htmlFor="cs-align">Alignment</label>
            <select id="cs-align" className="as-select" value={style.align}
              onChange={(e) => setStyle({ align: e.target.value as CaptionStyle["align"] })}>
              <option value="left">Left</option>
              <option value="center">Centre</option>
              <option value="right">Right</option>
            </select>
          </div>
          <Slider label="Safe margin" value={style.safeMargin} range={{ min: 0, max: 0.2, step: 0.005 }} format={fmtPct}
            onChange={(v) => setStyle({ safeMargin: v }, "margin")} />
          <Slider label="Words per line" value={style.maxWordsPerLine} range={{ min: 1, max: 20, step: 1 }} format={String}
            onChange={(v) => setStyle({ maxWordsPerLine: v }, "wpl")} />
          <Slider label="Lines" value={style.maxLines} range={{ min: 1, max: 4, step: 1 }} format={String}
            onChange={(v) => setStyle({ maxLines: v }, "lines")}
            help="A caption with more lines than this shows them in turn, as they're spoken." />
        </Section>

        <Section title="Animation" summary={style.animation === "none" ? "None" : style.animation}>
          <div className="as-row">
            <label htmlFor="cs-anim">Animation</label>
            <select id="cs-anim" className="as-select" value={style.animation}
              onChange={(e) => setStyle({ animation: e.target.value as CaptionStyle["animation"] })}>
              <option value="none">None</option>
              <option value="karaoke">Karaoke (highlight the spoken word)</option>
              <option value="pop">Word pop</option>
              <option value="reveal">Reveal word by word</option>
              <option value="fade">Fade in and out</option>
            </select>
          </div>
          {(style.animation === "pop" || style.animation === "fade") && (
            <Slider label="Duration" value={style.animationMs} range={{ min: 40, max: 600, step: 10 }} format={(v) => `${v} ms`}
              onChange={(v) => setStyle({ animationMs: v }, "anim")} />
          )}
        </Section>

        <Section title="Outline & background" summary={style.backgroundOpacity > 0 ? "Panel" : style.stroke > 0 ? "Outline" : "Plain"}>
          <Slider label="Outline" value={style.stroke} range={{ min: 0, max: 0.4, step: 0.01 }} format={fmtPct}
            onChange={(v) => setStyle({ stroke: v }, "stroke")} />
          <ColorRow label="Outline colour" value={style.strokeColor} onChange={(v) => setStyle({ strokeColor: v }, "strokeColor")} />
          <Switch label="Drop shadow" checked={style.shadow} onChange={(v) => setStyle({ shadow: v })} />
          <Slider label="Background" value={style.backgroundOpacity} range={{ min: 0, max: 1, step: 0.01 }} format={fmtPct}
            onChange={(v) => setStyle({ backgroundOpacity: v }, "bg")} />
          <ColorRow label="Background colour" value={style.background} onChange={(v) => setStyle({ background: v }, "bgColor")} />
        </Section>
      </div>

      <ol className="cs-list" aria-label="Captions">
        {captions.map((c, i) => {
          const e = editedById.get(c.id);
          const next = captions[i + 1];
          return (
            <li key={c.id} className={[c.id === activeId && "is-active", !e && "is-cut"].filter(Boolean).join(" ")}>
              <div className="cs-item-head">
                <button className="cs-time" onClick={() => onSeek(c.start)} title="Play from here">
                  {e ? `${stamp(e.start)} → ${stamp(e.end)}` : "Cut from the edit"}
                </button>
                <span className="cs-nudge" role="group" aria-label="Adjust timing">
                  <button onClick={() => setCaptions(retimeCaption(captions, c.id, c.start - NUDGE, c.end, duration), `t:${c.id}`)} aria-label="Start earlier" title="Start earlier">⇤</button>
                  <button onClick={() => setCaptions(retimeCaption(captions, c.id, c.start + NUDGE, c.end, duration), `t:${c.id}`)} aria-label="Start later" title="Start later">⇥</button>
                  <button onClick={() => setCaptions(retimeCaption(captions, c.id, c.start, c.end - NUDGE, duration), `t:${c.id}`)} aria-label="End earlier" title="End earlier">⇤</button>
                  <button onClick={() => setCaptions(retimeCaption(captions, c.id, c.start, c.end + NUDGE, duration), `t:${c.id}`)} aria-label="End later" title="End later">⇥</button>
                </span>
              </div>
              <textarea
                className="cs-text"
                aria-label={`Caption ${i + 1} text`}
                value={c.text}
                rows={Math.min(3, Math.ceil(c.text.length / 38) || 1)}
                onChange={(ev) => replaceAt(i, [setCaptionText(c, ev.target.value)])}
                onBlur={() => { if (!c.text.trim()) replaceAt(i, []); }}
              />
              <div className="cs-item-actions">
                <button onClick={() => { const s = splitCaption(c); if (s) replaceAt(i, s); }}
                  disabled={(c.words?.length ?? c.text.split(/\s+/).length) < 2}>Split</button>
                <button onClick={() => next && setCaptions([...captions.slice(0, i), mergeCaptions(c, next), ...captions.slice(i + 2)])}
                  disabled={!next}>Merge with next</button>
                <button onClick={() => replaceAt(i, [])} className="is-danger">Delete</button>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="ed-fine">
        Times are on the edited timeline. Captions under removed material disappear from the preview, the export and the
        subtitle files, and come back if you restore it.
      </p>
    </div>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="as-row">
      <label>
        {label}
        <input type="color" className="cs-color" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}
