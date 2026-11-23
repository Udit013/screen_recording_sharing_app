// Builds the AudioWorklet module that runs the effects engine on the live
// preview. AudioWorklet modules are loaded by URL and can't be bundled the way
// Web Workers are, so the module is assembled at runtime from the engine's
// own source text (see the note at the top of dsp.ts) and served as a Blob
// URL. tests/dsp.test.ts rebuilds the engine the same way to prove it works.

import { createAudioEngine } from "./dsp";

export const FX_PROCESSOR = "snapcast-fx";

/** Messages the main thread sends to the processor. */
export type FxPortMessage =
  | { type: "configure"; fx: unknown }
  | { type: "bypass"; value: boolean }
  | { type: "reset" };

/** Messages the processor sends back (~20 per second while audio flows). */
export type FxMeterMessage = { type: "meter"; inPeak: number; outPeak: number; reductionDb: number };

let cachedUrl: string | null = null;

export function fxWorkletUrl(): string {
  if (cachedUrl) return cachedUrl;
  const source = `
const createAudioEngine = ${createAudioEngine.toString()};

class SnapcastFxProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = createAudioEngine(sampleRate);
    this.bypass = false;
    this.configured = false;
    this.sinceMeter = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "configure") { this.engine.configure(m.fx); this.configured = true; }
      else if (m.type === "bypass") this.bypass = !!m.value;
      else if (m.type === "reset") this.engine.reset();
    };
  }
  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const L = output[0];
    const R = output.length > 1 ? output[1] : output[0];
    const input = inputs[0];
    if (!input || input.length === 0) { L.fill(0); R.fill(0); }
    else {
      // Mono sources are duplicated to both channels, as in the export.
      L.set(input[0]);
      R.set(input.length > 1 ? input[1] : input[0]);
    }
    if (this.configured && !this.bypass) this.engine.process(L, R, L.length);
    this.sinceMeter += L.length;
    if (this.sinceMeter >= sampleRate / 20) {
      this.sinceMeter = 0;
      const m = this.engine.readMeter();
      if (this.bypass || !this.configured) {
        // The engine didn't run, so measure the (untouched) block directly.
        let p = 0;
        for (let i = 0; i < L.length; i++) p = Math.max(p, Math.abs(L[i]), Math.abs(R[i]));
        m.inPeak = Math.max(m.inPeak, p);
        m.outPeak = Math.max(m.outPeak, p);
      }
      this.port.postMessage({ type: "meter", inPeak: m.inPeak, outPeak: m.outPeak, reductionDb: m.reductionDb });
    }
    return true;
  }
}

registerProcessor(${JSON.stringify(FX_PROCESSOR)}, SnapcastFxProcessor);
`;
  cachedUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  return cachedUrl;
}
