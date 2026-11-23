"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Section, Slider, Switch } from "./studio-ui";
import { createAudioEngine } from "@/lib/studio/dsp";
import {
  applyPatch, defaultFx, DELAY_PRESETS, EQ_PRESETS, PRESETS, RANGES, REVERB_PRESETS, sanitizeAudioFx,
  untouchedFx, type AudioFx, type EqBandType,
} from "@/lib/studio/fx";
import type { PreviewFxStatus, PreviewMeter } from "@/lib/studio/usePreviewFx";

interface AudioStudioProps {
  fx: AudioFx;
  /** `mergeKey` groups a slider drag into one undo step. */
  onChange: (fx: AudioFx, mergeKey?: string) => void;
  bypass: boolean;
  onBypassChange: (bypass: boolean) => void;
  previewStatus: PreviewFxStatus;
  meterRef: RefObject<PreviewMeter>;
}

const CUSTOM_KEY = "snapcast:audio-presets:v1";

interface CustomPreset {
  id: string;
  name: string;
  fx: AudioFx;
}

/** Settings a preset owns: everything except the timeline-level fades/loudness. */
const keepTimeline = (from: AudioFx, into: AudioFx): AudioFx => ({
  ...into,
  fadeInMs: from.fadeInMs,
  fadeOutMs: from.fadeOutMs,
  normalize: from.normalize,
});
const chainKey = (fx: AudioFx) => JSON.stringify({ ...keepTimeline(defaultFx(), fx), enabled: true });

function loadCustom(): CustomPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p) => p && typeof p.name === "string" && typeof p.id === "string")
      .slice(0, 50)
      .map((p) => ({ id: p.id, name: p.name.slice(0, 40), fx: sanitizeAudioFx(p.fx) }));
  } catch {
    return [];
  }
}

const fmtHz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)} kHz` : `${Math.round(v)} Hz`);
const fmtDb = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const fmtMs = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`);
const fmtPct = (v: number) => `${Math.round(v * 100)}%`;

export default function AudioStudio({ fx, onChange, bypass, onBypassChange, previewStatus, meterRef }: AudioStudioProps) {
  const [custom, setCustom] = useState<CustomPreset[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const [band, setBand] = useState(5);

  useEffect(() => setCustom(loadCustom()), []);
  const saveCustom = (list: CustomPreset[]) => {
    setCustom(list);
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
    } catch {
      /* storage unavailable: presets last for this session */
    }
  };

  /**
   * Applies a mutation to a copy of the settings. Changing any effect turns
   * effects on (only the master switch itself can turn them off), so a
   * control never appears to do nothing.
   */
  const update = (key: string, mutate: (d: AudioFx) => void) => {
    const next = structuredClone(fx);
    if (key !== "enabled") next.enabled = true;
    mutate(next);
    onChange(next, key);
  };

  const currentKey = chainKey(fx);
  const activePreset = !fx.enabled
    ? "off"
    : PRESETS.find((p) => chainKey(applyPatch(defaultFx(), p.patch)) === currentKey)?.id ??
    custom.find((p) => chainKey(p.fx) === currentKey)?.id ??
    (currentKey === chainKey(defaultFx()) ? "default" : "custom");

  const choosePreset = (id: string) => {
    if (id === "off") return onChange({ ...fx, enabled: false });
    if (id === "default") return onChange(keepTimeline(fx, defaultFx()));
    const builtIn = PRESETS.find((p) => p.id === id);
    if (builtIn) return onChange(keepTimeline(fx, applyPatch(defaultFx(), builtIn.patch)));
    const mine = custom.find((p) => p.id === id);
    if (mine) onChange(keepTimeline(fx, { ...mine.fx, enabled: true }));
  };

  return (
    <div className="as">
      <div className="as-top">
        <Switch label="Audio effects" checked={fx.enabled} onChange={(v) => update("enabled", (d) => { d.enabled = v; })} />
        <div className="ed-seg as-compare" role="radiogroup" aria-label="Compare">
          <button role="radio" aria-checked={bypass} className={bypass ? "is-on" : undefined} onClick={() => onBypassChange(true)}
            title="Hear the original audio (B)">Before</button>
          <button role="radio" aria-checked={!bypass} className={!bypass ? "is-on" : undefined} onClick={() => onBypassChange(false)}
            title="Hear the processed audio (B)">After</button>
        </div>
        <LevelMeter meterRef={meterRef} />
      </div>

      <p className={`as-status is-${previewStatus.state}`} role="status">
        {previewStatus.state === "idle" && "Press play to hear the effects live."}
        {previewStatus.state === "starting" && "Starting the live audio preview…"}
        {previewStatus.state === "live" && (bypass ? "Playing the original audio (Before)." : fx.enabled ? "Live: you're hearing the processed audio." : "Effects are off.")}
        {previewStatus.state === "unavailable" && `Live preview unavailable: ${previewStatus.reason} Exports still render the effects.`}
      </p>

      <div className="as-presets">
        <label className="as-field">
          <span>Preset</span>
          <select value={activePreset} onChange={(e) => choosePreset(e.target.value)}>
            <option value="off">None (original audio)</option>
            <option value="default">Safety limiter only</option>
            {activePreset === "custom" && <option value="custom">Custom settings</option>}
            <optgroup label="Built-in">
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </optgroup>
            {custom.length > 0 && (
              <optgroup label="My presets">
                {custom.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        {naming === null ? (
          <div className="as-preset-actions">
            <button className="ed-link" onClick={() => setNaming("")}>Save as preset</button>
            {custom.some((p) => p.id === activePreset) && (
              <button className="ed-link" onClick={() => saveCustom(custom.filter((p) => p.id !== activePreset))}>Delete preset</button>
            )}
          </div>
        ) : (
          <form
            className="as-name"
            onSubmit={(e) => {
              e.preventDefault();
              const name = naming.trim().slice(0, 40);
              if (!name) return;
              saveCustom([...custom, { id: `mine-${Date.now()}`, name, fx: keepTimeline(defaultFx(), fx) }]);
              setNaming(null);
            }}
          >
            <input autoFocus aria-label="Preset name" placeholder="Preset name" value={naming} maxLength={40}
              onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setNaming(null); }} />
            <button className="ed-btn is-small" type="submit" disabled={!naming.trim()}>Save</button>
            <button className="ed-link" type="button" onClick={() => setNaming(null)}>Cancel</button>
          </form>
        )}
        {PRESETS.find((p) => p.id === activePreset) && (
          <p className="ed-fine">{PRESETS.find((p) => p.id === activePreset)!.description}</p>
        )}
      </div>

      <fieldset className={fx.enabled ? "as-sections" : "as-sections is-off"}>
        <legend className="sr-only">Effect settings</legend>

        <Section title="Gain" summary={`In ${fmtDb(fx.inputGainDb)} · Out ${fmtDb(fx.outputGainDb)}`}>
          <Slider label="Input gain" value={fx.inputGainDb} range={RANGES.gainDb} format={fmtDb}
            help="Level going into the effects chain." onChange={(v) => update("inGain", (d) => { d.inputGainDb = v; })} />
          <Slider label="Output gain" value={fx.outputGainDb} range={RANGES.gainDb} format={fmtDb}
            help="Level after every effect, before the limiter." onChange={(v) => update("outGain", (d) => { d.outputGainDb = v; })} />
        </Section>

        <Section title="Clean up" enabled={fx.highpass.enabled || fx.lowpass.enabled || fx.gate.enabled}
          summary={[fx.highpass.enabled && `HPF ${fmtHz(fx.highpass.freq)}`, fx.gate.enabled && "Gate", fx.lowpass.enabled && `LPF ${fmtHz(fx.lowpass.freq)}`].filter(Boolean).join(" · ") || "Off"}>
          <Switch label="High-pass filter" checked={fx.highpass.enabled} help="Removes rumble, handling noise and hum below the cutoff."
            onChange={(v) => update("hp", (d) => { d.highpass.enabled = v; })} />
          {fx.highpass.enabled && (
            <Slider label="High-pass cutoff" value={fx.highpass.freq} range={RANGES.highpass} format={fmtHz} log
              onChange={(v) => update("hpf", (d) => { d.highpass.freq = v; })} />
          )}
          <Switch label="Noise gate" checked={fx.gate.enabled}
            help="Turns the level down between phrases, when the signal falls below the threshold."
            onChange={(v) => update("gate", (d) => { d.gate.enabled = v; })} />
          {fx.gate.enabled && (
            <>
              <Slider label="Gate threshold" value={fx.gate.thresholdDb} range={RANGES.gateThreshold} format={fmtDb}
                help="Below this level the gate closes." onChange={(v) => update("gthr", (d) => { d.gate.thresholdDb = v; })} />
              <Slider label="Gate depth" value={fx.gate.rangeDb} range={RANGES.gateRange} format={fmtDb}
                help="How far the level drops when closed. −90 dB is silence; −20 dB sounds more natural."
                onChange={(v) => update("grange", (d) => { d.gate.rangeDb = v; })} />
              <Slider label="Gate release" value={fx.gate.releaseMs} range={RANGES.releaseMs} format={fmtMs} log
                onChange={(v) => update("grel", (d) => { d.gate.releaseMs = v; })} />
            </>
          )}
          <Switch label="Low-pass filter" checked={fx.lowpass.enabled} help="Removes hiss and harshness above the cutoff."
            onChange={(v) => update("lp", (d) => { d.lowpass.enabled = v; })} />
          {fx.lowpass.enabled && (
            <Slider label="Low-pass cutoff" value={fx.lowpass.freq} range={RANGES.lowpass} format={fmtHz} log
              onChange={(v) => update("lpf", (d) => { d.lowpass.freq = v; })} />
          )}
        </Section>

        <Section title="Equalizer" enabled={fx.eq.enabled} onToggle={(v) => update("eq", (d) => { d.eq.enabled = v; })}
          summary={fx.eq.enabled ? `${fx.eq.bands.filter((b) => b.gainDb !== 0).length} bands shaped` : "Off"}>
          <div className="as-chips" role="group" aria-label="EQ presets">
            {EQ_PRESETS.map((p) => (
              <button key={p.id} type="button" className="as-chip"
                aria-pressed={fx.eq.bands.every((b, i) => b.gainDb === p.gains[i])}
                onClick={() => update("eqp", (d) => {
                  d.eq.enabled = true;
                  d.eq.bands = defaultFx().eq.bands.map((b, i) => ({ ...b, gainDb: p.gains[i] }));
                })}>
                {p.label}
              </button>
            ))}
          </div>
          <EqCurve fx={fx} selected={band} />
          <div className="as-eq" role="group" aria-label="EQ band gains">
            {fx.eq.bands.map((b, i) => (
              <label key={i} className={i === band ? "as-eq-band is-selected" : "as-eq-band"}>
                <span className="as-eq-gain">{b.gainDb > 0 ? "+" : ""}{b.gainDb.toFixed(1)}</span>
                <input type="range" min={RANGES.eqGain.min} max={RANGES.eqGain.max} step={RANGES.eqGain.step} value={b.gainDb}
                  aria-label={`${fmtHz(b.freq)} gain`} aria-valuetext={fmtDb(b.gainDb)}
                  onFocus={() => setBand(i)} onPointerDown={() => setBand(i)}
                  onChange={(e) => update(`eqg${i}`, (d) => { d.eq.enabled = true; d.eq.bands[i].gainDb = Number(e.target.value); })} />
                <span className="as-eq-freq">{fmtHz(b.freq).replace(" ", "")}</span>
              </label>
            ))}
          </div>
          <div className="as-band" aria-label={`Band ${band + 1} details`}>
            <label className="as-field">
              <span>Band {band + 1} shape</span>
              <select value={fx.eq.bands[band].type}
                onChange={(e) => update("eqt", (d) => { d.eq.bands[band].type = e.target.value as EqBandType; })}>
                <option value="lowshelf">Low shelf</option>
                <option value="peaking">Bell (peaking)</option>
                <option value="highshelf">High shelf</option>
              </select>
            </label>
            <Slider label="Frequency" value={fx.eq.bands[band].freq} range={RANGES.eqFreq} format={fmtHz} log
              onChange={(v) => update(`eqf${band}`, (d) => { d.eq.bands[band].freq = v; })} />
            <Slider label="Q (width)" value={fx.eq.bands[band].q} range={RANGES.eqQ} format={(v) => v.toFixed(2)} log
              help="Higher Q is a narrower band." onChange={(v) => update(`eqq${band}`, (d) => { d.eq.bands[band].q = v; })} />
          </div>
        </Section>

        <Section title="Compressor" enabled={fx.compressor.enabled} onToggle={(v) => update("comp", (d) => { d.compressor.enabled = v; })}
          summary={fx.compressor.enabled ? `${fx.compressor.ratio.toFixed(1)}:1 at ${fmtDb(fx.compressor.thresholdDb)}` : "Off"}>
          <Slider label="Threshold" value={fx.compressor.thresholdDb} range={RANGES.compThreshold} format={fmtDb}
            help="Levels above this are turned down." onChange={(v) => update("cthr", (d) => { d.compressor.thresholdDb = v; })} />
          <Slider label="Ratio" value={fx.compressor.ratio} range={RANGES.compRatio} format={(v) => `${v.toFixed(1)}:1`}
            help="4:1 means 4 dB over the threshold comes out as 1 dB over." onChange={(v) => update("cratio", (d) => { d.compressor.ratio = v; })} />
          <Slider label="Knee" value={fx.compressor.kneeDb} range={RANGES.compKnee} format={fmtDb}
            help="A wider knee starts compressing more gradually." onChange={(v) => update("cknee", (d) => { d.compressor.kneeDb = v; })} />
          <Slider label="Attack" value={fx.compressor.attackMs} range={RANGES.attackMs} format={fmtMs} log
            onChange={(v) => update("catt", (d) => { d.compressor.attackMs = v; })} />
          <Slider label="Release" value={fx.compressor.releaseMs} range={RANGES.releaseMs} format={fmtMs} log
            onChange={(v) => update("crel", (d) => { d.compressor.releaseMs = v; })} />
          <Slider label="Make-up gain" value={fx.compressor.makeupDb} range={RANGES.makeupDb} format={fmtDb}
            help="Restores the level the compression took away." onChange={(v) => update("cmk", (d) => { d.compressor.makeupDb = v; })} />
        </Section>

        <Section title="Echo / delay" enabled={fx.delay.enabled} onToggle={(v) => update("dly", (d) => { d.delay.enabled = v; })}
          summary={fx.delay.enabled ? `${fmtMs(fx.delay.timeMs)}${fx.delay.pingPong ? " · ping-pong" : ""}` : "Off"}>
          <div className="as-chips" role="group" aria-label="Delay presets">
            {DELAY_PRESETS.map((p) => (
              <button key={p.id} type="button" className="as-chip" onClick={() => update("dlyp", (d) => { d.delay = { enabled: true, ...p.delay }; })}>
                {p.label}
              </button>
            ))}
          </div>
          <Slider label="Delay time" value={fx.delay.timeMs} range={RANGES.delayMs} format={fmtMs} log
            onChange={(v) => update("dtime", (d) => { d.delay.timeMs = v; })} />
          <Slider label="Feedback" value={fx.delay.feedback} range={RANGES.feedback} format={fmtPct}
            help="How much of each echo repeats. Capped at 85% so it always dies away." onChange={(v) => update("dfb", (d) => { d.delay.feedback = v; })} />
          <Slider label="Mix" value={fx.delay.mix} range={RANGES.mix} format={fmtPct} onChange={(v) => update("dmix", (d) => { d.delay.mix = v; })} />
          <Switch label="Stereo ping-pong" checked={fx.delay.pingPong} help="Echoes alternate between left and right."
            onChange={(v) => update("dpp", (d) => { d.delay.pingPong = v; })} />
        </Section>

        <Section title="Reverb" enabled={fx.reverb.enabled} onToggle={(v) => update("rev", (d) => { d.reverb.enabled = v; })}
          summary={fx.reverb.enabled ? `Size ${fmtPct(fx.reverb.roomSize)} · mix ${fmtPct(fx.reverb.mix)}` : "Off"}>
          <div className="as-chips" role="group" aria-label="Reverb presets">
            {REVERB_PRESETS.map((p) => (
              <button key={p.id} type="button" className="as-chip" onClick={() => update("revp", (d) => { d.reverb = { enabled: true, ...p.reverb }; })}>
                {p.label}
              </button>
            ))}
          </div>
          <Slider label="Room size / decay" value={fx.reverb.roomSize} range={RANGES.roomSize} format={fmtPct}
            help="Larger rooms ring for longer." onChange={(v) => update("rsize", (d) => { d.reverb.roomSize = v; })} />
          <Slider label="Damping" value={fx.reverb.damping} range={RANGES.damping} format={fmtPct}
            help="How quickly high frequencies die away in the tail." onChange={(v) => update("rdamp", (d) => { d.reverb.damping = v; })} />
          <Slider label="Pre-delay" value={fx.reverb.preDelayMs} range={RANGES.preDelayMs} format={fmtMs}
            help="Gap before the reverb starts, keeping the voice clear." onChange={(v) => update("rpre", (d) => { d.reverb.preDelayMs = v; })} />
          <Slider label="Stereo width" value={fx.reverb.width} range={RANGES.width} format={fmtPct}
            onChange={(v) => update("rwidth", (d) => { d.reverb.width = v; })} />
          <Slider label="Mix" value={fx.reverb.mix} range={RANGES.mix} format={fmtPct} onChange={(v) => update("rmix", (d) => { d.reverb.mix = v; })} />
        </Section>

        <Section title="Limiter" enabled={fx.limiter.enabled} onToggle={(v) => update("lim", (d) => { d.limiter.enabled = v; })}
          summary={fx.limiter.enabled ? `Ceiling ${fmtDb(fx.limiter.ceilingDb)}` : "Off: audio can clip"}>
          <Slider label="Ceiling" value={fx.limiter.ceilingDb} range={RANGES.ceilingDb} format={fmtDb}
            help="No sample leaves the chain above this level." onChange={(v) => update("lceil", (d) => { d.limiter.ceilingDb = v; })} />
          <Slider label="Release" value={fx.limiter.releaseMs} range={RANGES.releaseMs} format={fmtMs} log
            onChange={(v) => update("lrel", (d) => { d.limiter.releaseMs = v; })} />
        </Section>

        <Section title="Fades & loudness" enabled={fx.fadeInMs > 0 || fx.fadeOutMs > 0 || fx.normalize.enabled}
          summary={[fx.fadeInMs > 0 && `In ${fmtMs(fx.fadeInMs)}`, fx.fadeOutMs > 0 && `Out ${fmtMs(fx.fadeOutMs)}`, fx.normalize.enabled && "Normalize"].filter(Boolean).join(" · ") || "Off"}>
          <Slider label="Fade in" value={fx.fadeInMs} range={RANGES.fadeMs} format={fmtMs}
            help="From the start of the edited video." onChange={(v) => update("fin", (d) => { d.fadeInMs = v; })} />
          <Slider label="Fade out" value={fx.fadeOutMs} range={RANGES.fadeMs} format={fmtMs}
            help="Into the end of the edited video." onChange={(v) => update("fout", (d) => { d.fadeOutMs = v; })} />
          <Switch label="Peak normalize on export" checked={fx.normalize.enabled}
            help="Measures the processed audio's peak in a first pass, then scales it to the target. Needs the whole file, so it applies when exporting, not in the live preview."
            onChange={(v) => update("norm", (d) => { d.normalize.enabled = v; })} />
          {fx.normalize.enabled && (
            <Slider label="Normalize to" value={fx.normalize.targetDb} range={RANGES.normalizeDb} format={fmtDb}
              onChange={(v) => update("normt", (d) => { d.normalize.targetDb = v; })} />
          )}
        </Section>
      </fieldset>

      <button className="ed-link as-reset" onClick={() => onChange(untouchedFx())}>Reset all audio settings</button>
    </div>
  );
}

// ── Controls ─────────────────────────────────────────────────────────────

/** The EQ's real magnitude response, computed by the engine from the same coefficients it filters with. */
function EqCurve({ fx, selected }: { fx: AudioFx; selected: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const engine = useMemo(() => createAudioEngine(48000), []);
  const freqs = useMemo(() => Array.from({ length: 160 }, (_, i) => 20 * Math.pow(1000, i / 159)), []);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    engine.configure({ ...fx, enabled: true, eq: { ...fx.eq, enabled: true } });
    const resp = engine.eqResponse(freqs);
    const css = getComputedStyle(canvas);
    const yFor = (db: number) => h / 2 - (db / 18) * (h / 2 - 4);
    const xFor = (f: number) => (Math.log(f / 20) / Math.log(1000)) * w;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = css.getPropertyValue("--as-grid").trim() || "rgba(108,102,133,0.18)";
    ctx.lineWidth = 1;
    for (const f of [100, 1000, 10000]) { ctx.beginPath(); ctx.moveTo(xFor(f), 0); ctx.lineTo(xFor(f), h); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(0, yFor(0)); ctx.lineTo(w, yFor(0)); ctx.stroke();
    const b = fx.eq.bands[selected];
    if (b) {
      ctx.fillStyle = "rgba(255,67,147,0.12)";
      ctx.fillRect(xFor(b.freq) - 1.5, 0, 3, h);
    }
    ctx.beginPath();
    resp.forEach((db, i) => (i ? ctx.lineTo(xFor(freqs[i]), yFor(db)) : ctx.moveTo(xFor(freqs[i]), yFor(db))));
    ctx.strokeStyle = fx.eq.enabled ? "#ff4393" : "rgba(108,102,133,0.5)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [fx, selected, engine, freqs]);

  return <canvas ref={ref} className="as-curve" role="img" aria-label="EQ frequency response, 20 Hz to 20 kHz, ±18 dB" />;
}

/** Output level and gain reduction from the worklet, drawn without React re-renders. */
function LevelMeter({ meterRef }: { meterRef: RefObject<PreviewMeter> }) {
  const outRef = useRef<HTMLSpanElement>(null);
  const grRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let shown = 0;
    const tick = () => {
      const m = meterRef.current;
      const db = 20 * Math.log10(Math.max(m.outPeak, 1e-6));
      const target = Math.max(0, Math.min(1, (db + 60) / 60));
      shown = target > shown ? target : shown * 0.92 + target * 0.08;
      if (outRef.current) {
        outRef.current.style.transform = `scaleX(${shown})`;
        outRef.current.dataset.hot = db > -1.5 ? "1" : "0";
      }
      if (grRef.current) grRef.current.style.transform = `scaleX(${Math.min(1, m.reductionDb / 20)})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [meterRef]);
  return (
    <div className="as-meter" aria-hidden title="Output level (top) and gain reduction (bottom)">
      <span className="as-meter-out"><span ref={outRef} /></span>
      <span className="as-meter-gr"><span ref={grRef} /></span>
    </div>
  );
}
