"use client";

// Controls shared by the studio panels (Audio, Captions): collapsible
// sections, labelled switches and sliders with optional log mapping.

import { useId, useState, type ReactNode } from "react";
import type { Range as FxRange } from "@/lib/studio/fx";

type Range = Pick<FxRange, "min" | "max" | "step">;

export function Section({
  title, summary, enabled, onToggle, children,
}: { title: string; summary: string; enabled?: boolean; onToggle?: (v: boolean) => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <section className={open ? "as-sec is-open" : "as-sec"}>
      <div className="as-sec-head">
        <button type="button" className="as-sec-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden><path d="m9 6 6 6-6 6" /></svg>
          <span className="as-sec-title">{title}</span>
          <span className={enabled ? "as-sec-summary is-on" : "as-sec-summary"}>{summary}</span>
        </button>
        {onToggle && <SwitchButton label={`${title} on`} checked={!!enabled} onChange={onToggle} />}
      </div>
      {open && <div className="as-sec-body" id={id}>{children}</div>}
    </section>
  );
}

export function SwitchButton({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="as-switch" onClick={() => onChange(!checked)}>
      <span aria-hidden />
    </button>
  );
}

export function Switch({ label, checked, onChange, help }: { label: string; checked: boolean; onChange: (v: boolean) => void; help?: string }) {
  const id = useId();
  return (
    <div className="as-row as-switch-row" title={help}>
      <span id={id}>{label}</span>
      <button type="button" role="switch" aria-checked={checked} aria-labelledby={id} className="as-switch" onClick={() => onChange(!checked)}>
        <span aria-hidden />
      </button>
      {help && <small className="as-help">{help}</small>}
    </div>
  );
}

/**
 * A labelled range input. `log` maps the slider position logarithmically
 * (frequencies, times), so the musically useful end isn't squeezed into a
 * few pixels.
 */
export function Slider({
  label, value, range, format, onChange, help, log = false,
}: { label: string; value: number; range: Range; format: (v: number) => string; onChange: (v: number) => void; help?: string; log?: boolean }) {
  const id = useId();
  const STEPS = 1000;
  const toPos = (v: number) =>
    log ? Math.round((Math.log(v / range.min) / Math.log(range.max / range.min)) * STEPS) : v;
  const fromPos = (p: number) => {
    const v = log ? range.min * Math.pow(range.max / range.min, p / STEPS) : p;
    const snapped = Math.round(v / range.step) * range.step;
    return Math.min(range.max, Math.max(range.min, Number(snapped.toFixed(4))));
  };
  return (
    <div className="as-row as-slider" title={help}>
      <label htmlFor={id}>{label}</label>
      <output htmlFor={id}>{format(value)}</output>
      <input
        id={id}
        type="range"
        min={log ? 0 : range.min}
        max={log ? STEPS : range.max}
        step={log ? 1 : range.step}
        value={toPos(value)}
        aria-valuetext={format(value)}
        onChange={(e) => onChange(fromPos(Number(e.target.value)))}
      />
      {help && <small className="as-help">{help}</small>}
    </div>
  );
}
