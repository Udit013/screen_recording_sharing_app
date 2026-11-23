"use client";

// The Video tab: output shape (aspect presets), how the recording fills it
// (fit with bars, fill and crop, or fit over a blurred copy), manual crop,
// reposition, and colour adjustments. Everything is previewed live on the
// stage and rendered into MP4 exports by the same code.

import { ASPECTS, defaultLook, isIdentityLook, sanitizeLook, type FitMode, type VideoLook } from "@/lib/studio/frame";
import { Section, Slider } from "./studio-ui";

interface VideoStudioProps {
  look: VideoLook;
  /** `mergeKey` groups a slider drag into one undo step. */
  onChange: (look: VideoLook, mergeKey?: string) => void;
}

const FITS: { id: FitMode; label: string; hint: string }[] = [
  { id: "fill", label: "Fill", hint: "Crop to fill the frame. Choose what stays in view below." },
  { id: "fit", label: "Fit", hint: "Show everything, with bars." },
  { id: "blur", label: "Blur", hint: "Show everything over a blurred, dimmed copy." },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signed = (v: number) => (v === 0 ? "0" : `${v > 0 ? "+" : ""}${Math.round(v)}`);

export default function VideoStudio({ look, onChange }: VideoStudioProps) {
  const set = (patch: Partial<VideoLook>, mergeKey?: string) => onChange(sanitizeLook({ ...look, ...patch }), mergeKey);
  const reframed = look.aspect !== "source";
  const { crop } = look;
  // Crop is edited as four trims; a trim never lets the region drop below 10%.
  const setTrim = (side: "left" | "right" | "top" | "bottom", v: number) => {
    let { x, y, w, h } = crop;
    if (side === "left") { const r = x + w; x = Math.min(v, r - 0.1); w = r - x; }
    if (side === "right") { w = Math.max(0.1, 1 - v - x); }
    if (side === "top") { const b = y + h; y = Math.min(v, b - 0.1); h = b - y; }
    if (side === "bottom") { h = Math.max(0.1, 1 - v - y); }
    set({ crop: { x, y, w, h } }, `crop:${side}`);
  };
  const cropped = crop.x > 0 || crop.y > 0 || crop.w < 1 || crop.h < 1;
  const adjusted = look.brightness !== 0 || look.contrast !== 0 || look.saturation !== 0;

  return (
    <div className="cs vs">
      <div className="vs-head">
        <p className="ed-fine">Previewed live and rendered into the MP4 export.</p>
        <button className="ed-btn is-small" onClick={() => onChange(defaultLook())} disabled={isIdentityLook(look)}>Reset</button>
      </div>

      <fieldset className="vs-aspects">
        <legend>Shape</legend>
        {ASPECTS.map((a) => (
          <button key={a.id} type="button" aria-pressed={look.aspect === a.id} title={a.hint}
            className={look.aspect === a.id ? "vs-aspect is-on" : "vs-aspect"} onClick={() => set({ aspect: a.id })}>
            <span className="vs-aspect-shape" aria-hidden style={{ aspectRatio: a.ratio ? String(a.ratio) : "16 / 10" }} />
            <strong>{a.label}</strong>
            <small>{a.hint}</small>
          </button>
        ))}
      </fieldset>

      {reframed && (
        <div className="ex-seg" role="radiogroup" aria-label="How the video fills the frame">
          {FITS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={look.fit === f.id} title={f.hint}
              className={look.fit === f.id ? "is-on" : undefined} onClick={() => set({ fit: f.id })}>
              {f.label}
            </button>
          ))}
        </div>
      )}

      <div className="as-sections">
        {reframed && look.fit === "fill" && (
          <Section title="Position" summary={`${pct(look.focusX)} · ${pct(look.focusY)}`}>
            <Slider label="Horizontal" value={look.focusX} range={{ min: 0, max: 1, step: 0.01 }} format={pct}
              onChange={(v) => set({ focusX: v }, "fx")} help="Which part of the recording stays in view when the sides are cut off." />
            <Slider label="Vertical" value={look.focusY} range={{ min: 0, max: 1, step: 0.01 }} format={pct}
              onChange={(v) => set({ focusY: v }, "fy")} />
          </Section>
        )}
        {reframed && look.fit === "fit" && (
          <Section title="Bars" summary={look.background}>
            <div className="as-row">
              <label>
                Colour
                <input type="color" className="cs-color" value={look.background} onChange={(e) => set({ background: e.target.value }, "bg")} />
              </label>
            </div>
          </Section>
        )}
        <Section title="Crop" summary={cropped ? `${pct(crop.w)} × ${pct(crop.h)}` : "None"}>
          <Slider label="Left" value={crop.x} range={{ min: 0, max: 0.9, step: 0.005 }} format={pct} onChange={(v) => setTrim("left", v)} />
          <Slider label="Right" value={1 - crop.x - crop.w} range={{ min: 0, max: 0.9, step: 0.005 }} format={pct} onChange={(v) => setTrim("right", v)} />
          <Slider label="Top" value={crop.y} range={{ min: 0, max: 0.9, step: 0.005 }} format={pct} onChange={(v) => setTrim("top", v)} />
          <Slider label="Bottom" value={1 - crop.y - crop.h} range={{ min: 0, max: 0.9, step: 0.005 }} format={pct} onChange={(v) => setTrim("bottom", v)} />
          {cropped && <button className="ed-btn is-small" onClick={() => set({ crop: { x: 0, y: 0, w: 1, h: 1 } })}>Remove crop</button>}
        </Section>
        <Section title="Colour" summary={adjusted ? "Adjusted" : "Original"}>
          <Slider label="Brightness" value={look.brightness} range={{ min: -100, max: 100, step: 1 }} format={signed}
            onChange={(v) => set({ brightness: v }, "br")} />
          <Slider label="Contrast" value={look.contrast} range={{ min: -100, max: 100, step: 1 }} format={signed}
            onChange={(v) => set({ contrast: v }, "co")} />
          <Slider label="Saturation" value={look.saturation} range={{ min: -100, max: 100, step: 1 }} format={signed}
            onChange={(v) => set({ saturation: v }, "sa")} help="−100 is black and white." />
        </Section>
      </div>
    </div>
  );
}
