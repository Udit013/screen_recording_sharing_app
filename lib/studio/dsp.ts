// The audio-effects engine. One implementation, three callers:
//   - the AudioWorklet that processes the live preview (lib/studio/worklet.ts),
//   - the export worker that renders the final file (lib/media/export.worker.ts),
//   - the unit tests (tests/dsp.test.ts), which run it in Node.
// So the preview is the same signal path as the export, and every effect is
// testable as plain numbers in, numbers out.
//
// IMPORTANT: createAudioEngine is injected into the AudioWorklet as source
// text (Function.prototype.toString), because AudioWorklet modules can't be
// bundled like Workers. It must therefore reference nothing outside its own
// body: no imports at runtime, no module-level constants, no class fields or
// other syntax the compiler might lower into shared helpers. Type-only
// imports are fine; they are erased.
//
// Always stereo: mono sources are duplicated to two channels before
// processing, in both preview and export, so stereo effects (reverb width,
// ping-pong delay) sound identical in both.
//
// Algorithms (all implemented here from their published descriptions):
//   - Biquad filters: Robert Bristow-Johnson's "Audio EQ Cookbook" formulas.
//   - Reverb: the Freeverb topology (Jezar at Dreampoint, public domain):
//     8 damped comb filters + 4 allpass filters per channel.
//   - Compressor / gate: feed-forward, stereo-linked envelope followers.
//   - Limiter: look-ahead peak limiter with a sliding-window minimum, plus a
//     final hard clamp so the ceiling is a guarantee, not a target.
//   - Pitch shift: a two-head delay-line shifter with waveform-aligned
//     splices (the idea behind WSOLA). Each read head plays the input at the
//     pitch ratio for one grain, faded in and out with a sin² window; the two
//     heads are half a grain apart so their gains always sum to one. When a
//     head restarts (at zero gain) it searches up to 12.5 ms for the offset
//     whose waveform best matches the other head, so the crossfade adds no
//     phase jump and the output pitch is exact. Formants shift with pitch.
//   - Pitch correction: YIN pitch detection (de Cheveigné & Kawahara, 2002)
//     on a 2× downsampled mono copy every 512 samples; the nearest note of
//     the chosen key/scale (with hysteresis) sets a target, the correction in
//     cents is scaled by strength and smoothed by the retune time, and it
//     drives the same shifter with a time-varying ratio.

/* eslint-disable no-var -- `var` keeps the injected worklet source free of
   block-scoping transforms the compiler might otherwise emit. */

import type { AudioFx } from "./fx";

export interface EngineMeter {
  /** Peak level in, 0..1+, since the last read. */
  inPeak: number;
  outPeak: number;
  /** Largest gain reduction from the compressor and limiter, in dB (≥ 0). */
  reductionDb: number;
  /** Pitch correction: last detected pitch in Hz (0 = unvoiced), target note (MIDI) and applied correction in cents. */
  pitchHz?: number;
  targetMidi?: number;
  correctionCents?: number;
}

export interface AudioEngine {
  configure(fx: AudioFx): void;
  /** Processes two channels in place. */
  process(left: Float32Array, right: Float32Array, frames: number): void;
  reset(): void;
  /** Frames of delay the engine adds (limiter look-ahead + pitch shifter's mean delay), or 0. */
  latency(): number;
  readMeter(): EngineMeter;
  /** The EQ's magnitude response in dB at each frequency. */
  eqResponse(freqs: number[]): number[];
}

export function createAudioEngine(sampleRate: number): AudioEngine {
  var SR = sampleRate;
  var dbToGain = function (db: number) { return Math.pow(10, db / 20); };
  var gainToDb = function (g: number) { return 20 * Math.log10(g > 1e-12 ? g : 1e-12); };
  var coefFor = function (ms: number) { return Math.exp(-1 / (Math.max(ms, 0.01) * 0.001 * SR)); };
  var flush = function (v: number) { return v > 1e-18 || v < -1e-18 ? v : 0; };

  // ── Biquad (transposed direct form II), one state pair per channel ──
  type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number; z1: number[]; z2: number[]; on: boolean };
  function newBiquad(): Biquad {
    return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, z1: [0, 0], z2: [0, 0], on: false };
  }
  function designBiquad(f: Biquad, type: string, freq: number, q: number, gainDb: number) {
    var fc = Math.min(Math.max(freq, 10), SR * 0.49);
    var w0 = (2 * Math.PI * fc) / SR;
    var cs = Math.cos(w0), sn = Math.sin(w0);
    var alpha = sn / (2 * Math.max(q, 0.01));
    var A = Math.pow(10, gainDb / 40);
    var b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0, sq;
    if (type === "lowpass") {
      b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
    } else if (type === "highpass") {
      b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; a0 = 1 + alpha; a1 = -2 * cs; a2 = 1 - alpha;
    } else if (type === "peaking") {
      b0 = 1 + alpha * A; b1 = -2 * cs; b2 = 1 - alpha * A; a0 = 1 + alpha / A; a1 = -2 * cs; a2 = 1 - alpha / A;
    } else if (type === "lowshelf") {
      sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cs + sq); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sq);
      a0 = (A + 1) + (A - 1) * cs + sq; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sq;
    } else if (type === "highshelf") {
      sq = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cs + sq); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sq);
      a0 = (A + 1) - (A - 1) * cs + sq; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sq;
    }
    f.b0 = b0 / a0; f.b1 = b1 / a0; f.b2 = b2 / a0; f.a1 = a1 / a0; f.a2 = a2 / a0;
  }
  function runBiquad(f: Biquad, x: number, c: number) {
    var y = f.b0 * x + f.z1[c];
    f.z1[c] = flush(f.b1 * x - f.a1 * y + f.z2[c]);
    f.z2[c] = flush(f.b2 * x - f.a2 * y);
    return y;
  }
  function magnitudeDb(f: Biquad, freq: number) {
    var w = (2 * Math.PI * freq) / SR;
    var c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    var nr = f.b0 + f.b1 * c1 + f.b2 * c2, ni = -(f.b1 * s1 + f.b2 * s2);
    var dr = 1 + f.a1 * c1 + f.a2 * c2, di = -(f.a1 * s1 + f.a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / Math.max(dr * dr + di * di, 1e-30));
  }

  // ── Stages ──
  var hp = newBiquad(), lp = newBiquad();
  var eqBands: Biquad[] = [];
  for (var bi = 0; bi < 10; bi++) eqBands.push(newBiquad());

  // Gate
  var gateEnv = 0, gateGain = 1, gateHold = 0;
  var gateOn = false, gateThr = 0, gateFloor = 1, gateAtt = 0, gateRel = 0, gateEnvRel = coefFor(30);
  var gateHoldFrames = Math.round(0.05 * SR);

  // Compressor
  var compOn = false, compThr = 0, compRatio = 1, compKnee = 0, compAtt = 0, compRel = 0, compMakeup = 1, compGr = 0;

  // Delay (2 s per channel)
  var DMAX = Math.ceil(2 * SR) + 2;
  var dBufL = new Float32Array(DMAX), dBufR = new Float32Array(DMAX), dPos = 0;
  var delayOn = false, delayFrames = 1, delayFb = 0, delayMix = 0, delayPing = false;

  // Reverb (Freeverb). Tunings are for 44.1 kHz and scaled to the rate.
  var combTune = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
  var apTune = [556, 441, 341, 225];
  var SPREAD = 23;
  var rscale = SR / 44100;
  type Comb = { buf: Float32Array; pos: number; store: number };
  type Allpass = { buf: Float32Array; pos: number };
  var combsL: Comb[] = [], combsR: Comb[] = [], apsL: Allpass[] = [], apsR: Allpass[] = [];
  for (var ci = 0; ci < combTune.length; ci++) {
    combsL.push({ buf: new Float32Array(Math.max(1, Math.round(combTune[ci] * rscale))), pos: 0, store: 0 });
    combsR.push({ buf: new Float32Array(Math.max(1, Math.round((combTune[ci] + SPREAD) * rscale))), pos: 0, store: 0 });
  }
  for (var ai = 0; ai < apTune.length; ai++) {
    apsL.push({ buf: new Float32Array(Math.max(1, Math.round(apTune[ai] * rscale))), pos: 0 });
    apsR.push({ buf: new Float32Array(Math.max(1, Math.round((apTune[ai] + SPREAD) * rscale))), pos: 0 });
  }
  var PMAX = Math.ceil(0.2 * SR) + 2;
  var preL = new Float32Array(PMAX), preR = new Float32Array(PMAX), prePos = 0;
  var revOn = false, revFb = 0.84, revDamp = 0.2, revWet1 = 0, revWet2 = 0, revDry = 1, revPre = 0;

  function runComb(cb: Comb, x: number, fb: number, damp: number) {
    var out = cb.buf[cb.pos];
    cb.store = flush(out * (1 - damp) + cb.store * damp);
    cb.buf[cb.pos] = x + cb.store * fb;
    cb.pos = cb.pos + 1 === cb.buf.length ? 0 : cb.pos + 1;
    return out;
  }
  function runAllpass(ap: Allpass, x: number) {
    var bufout = ap.buf[ap.pos];
    var out = -x + bufout;
    ap.buf[ap.pos] = flush(x + bufout * 0.5);
    ap.pos = ap.pos + 1 === ap.buf.length ? 0 : ap.pos + 1;
    return out;
  }

  // Gains (smoothed so slider moves don't click)
  // Pitch shifter (see the header). Delays are in frames behind the write
  // position; a head's delay changes by (1 − ratio) per frame.
  var PSW = Math.round(0.06 * SR);       // sweep: how far a head's delay travels in one grain
  var PSK = Math.round(0.0125 * SR);     // splice search range (one period of 80 Hz)
  var PSC = Math.round(0.01 * SR);       // correlation window
  // Pitch correction reads the delay line this far back, so the audio being
  // corrected is the audio the detector just analysed (its window's centre
  // plus half a hop). Measured without it: correction trailed 5 Hz vibrato
  // and removed little of it.
  var AT_HOP = 256;
  var DLAG = Math.round((0.032 * SR + SR / 65) / 2) + AT_HOP / 2;
  var PSN = PSW + PSK + PSC + DLAG + 8;
  var psL = new Float32Array(PSN), psR = new Float32Array(PSN), psM = new Float32Array(PSN), psPos = 0;
  var psOn = false, psRatio = 1, psGrain = PSW, psManual = 1;
  // Pitch correction state. Grains are capped at 40 ms while correcting, so
  // a ratio that changes from moment to moment stays inside the buffer.
  var atOn = false, atStrength = 1, atAlpha = 1, atKey = 0, atAllowed = [true, true, true, true, true, true, true, true, true, true, true, true];
  var GCAP = Math.round(0.04 * SR);
  // Detector rate: decimated to ~16 kHz (×3 at 44.1/48 kHz), plenty for voice pitch.
  var DEC = SR >= 32000 ? 3 : 2;
  var DSR = SR / DEC, DW = Math.round(0.032 * DSR), TMIN = Math.max(2, Math.floor(DSR / 1000)), TMAX = Math.ceil(DSR / 65);
  var DN = 2048; while (DN < DW + TMAX + 4) DN *= 2;
  var det = new Float32Array(DN), detPos = 0, detHalf = 0, detCount = 0, detPrev = 0;
  var yd = new Float64Array(TMAX + 2);
  var atCents = 0, atTarget = -1, atHz = 0, atUnvoiced = 0;
  var HOP = AT_HOP;
  var AT_SCALES: Record<string, number[]> = {
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10],
    "harmonic-minor": [0, 2, 3, 5, 7, 8, 11], "major-pentatonic": [0, 2, 4, 7, 9], "minor-pentatonic": [0, 3, 5, 7, 10], blues: [0, 3, 5, 6, 7, 10],
  };
  function grainFor(r: number) {
    var g = Math.abs(1 - r) < 1e-6 ? GCAP : PSW / Math.abs(1 - r);
    return Math.max(PSC, atOn ? Math.min(g, GCAP) : g);
  }
  /** YIN on the newest DW + TMAX downsampled samples: f0 in Hz, or 0 when unvoiced. */
  function yin() {
    var start = detPos - (DW + TMAX);
    var energy = 0;
    for (var j = 0; j < DW; j++) { var x0 = det[(start + j + DN) & (DN - 1)]; energy += x0 * x0; }
    if (energy / DW < 1e-5) return 0; // below about -50 dBFS: treat as silence
    var run = 0, tau, best = -1;
    yd[0] = 1;
    for (tau = 1; tau <= TMAX; tau++) {
      var sum = 0;
      for (var k = 0; k < DW; k++) {
        var df = det[(start + k + DN) & (DN - 1)] - det[(start + k + tau + DN) & (DN - 1)];
        sum += df * df;
      }
      run += sum;
      yd[tau] = run > 0 ? (sum * tau) / run : 1;
      if (tau > TMIN && best < 0 && yd[tau - 1] < 0.15 && yd[tau - 1] <= yd[tau]) best = tau - 1;
    }
    if (best < 0) return 0;
    // Parabolic interpolation around the dip.
    var a = yd[best - 1], b = yd[best], c = yd[best + 1];
    var den = a - 2 * b + c;
    var t = den !== 0 ? best + (0.5 * (a - c)) / den : best;
    return DSR / t;
  }
  /** Nearest allowed note (MIDI) to `midi`, keeping the current one unless clearly past it. */
  function snap(midi: number) {
    if (atTarget >= 0 && Math.abs(midi - atTarget) < 0.65) return atTarget;
    var bestN = -1, bestD = 99;
    for (var o = -7; o <= 7; o++) {
      var n = Math.round(midi) + o;
      if (!atAllowed[((n - atKey) % 12 + 12) % 12]) continue;
      var d = Math.abs(n - midi);
      if (d < bestD) { bestD = d; bestN = n; }
    }
    return bestN;
  }
  /** Runs every HOP samples while correcting: updates the shift ratio. */
  function correctPitch() {
    var f0 = yin();
    atHz = f0;
    var want = 0;
    if (f0 > 0) {
      atUnvoiced = 0;
      var midi = 69 + 12 * Math.log(f0 * psManual / 440) / Math.LN2;
      atTarget = snap(midi);
      want = atTarget >= 0 ? (atTarget - midi) * 100 * atStrength : 0;
      atCents += (want - atCents) * atAlpha;
    } else {
      // Hold through short consonants, then let go.
      if (++atUnvoiced * HOP > 0.12 * SR) { atTarget = -1; atCents += (0 - atCents) * atAlpha; }
    }
    psRatio = psManual * Math.pow(2, atCents / 1200);
    psGrain = grainFor(psRatio);
  }
  var hdD = [0, 0], hdAge = [0, 0.5];
  function psAt(buf: Float32Array, d: number) {
    var f = psPos - d;
    var i = Math.floor(f);
    var fr = f - i;
    var i0 = ((i % PSN) + PSN) % PSN;
    var i1 = i0 + 1 === PSN ? 0 : i0 + 1;
    return buf[i0] * (1 - fr) + buf[i1] * fr;
  }
  /** Correlation of the mono history at integer delays d and od (stride 2), normalised by d's energy. */
  function psScore(d: number, od: number) {
    var dot = 0, en = 0;
    var ia = psPos - d, ib = psPos - od;
    for (var j = 0; j < PSC; j += 2) {
      var pa = ia - j, pb = ib - j;
      if (pa < 0) pa += PSN;
      if (pb < 0) pb += PSN;
      var a = psM[pa], b = psM[pb];
      dot += a * b; en += a * a;
    }
    return dot / Math.sqrt(en + 1e-9);
  }
  /**
   * Where a restarting head should start so its waveform lines up with head
   * `other`: a coarse search every 3 frames, refined to the frame. Integer
   * indexing on a mono copy keeps a splice well under one render quantum.
   */
  function psSplice(other: number) {
    // Pitch up: start far enough back to catch up for one grain; down: start near and fall back.
    // While correcting, everything sits DLAG further back (see DLAG).
    var base = (atOn ? DLAG : 0) + (psRatio > 1 ? Math.min(PSW, Math.ceil((psRatio - 1) * psGrain) + 2) : 0);
    var od = Math.round(hdD[other]);
    var best = base, bestScore = -Infinity, k, sc;
    for (k = 0; k <= PSK; k += 3) {
      sc = psScore(base + k, od);
      if (sc > bestScore) { bestScore = sc; best = base + k; }
    }
    var c = best;
    for (k = c - 2; k <= c + 2; k++) {
      if (k < base || k > base + PSK || k === c) continue;
      sc = psScore(k, od);
      if (sc > bestScore) { bestScore = sc; best = k; }
    }
    return best + (hdD[other] - od); // keep the other head's sub-frame phase
  }
  function psResetHeads() {
    var base = (atOn ? DLAG : 0) + (psRatio > 1 ? Math.min(PSW, Math.ceil((psRatio - 1) * psGrain) + 2) : 0);
    // Half a grain apart in age, and in delay: each at its own point of the sweep.
    hdAge[0] = 0; hdAge[1] = 0.5;
    hdD[0] = base; hdD[1] = base + (1 - psRatio) * psGrain * 0.5;
    if (hdD[1] < 0) hdD[1] = 0;
  }

  var inGainT = 1, inGain = 1, outGainT = 1, outGain = 1;
  var smooth = coefFor(10);

  // Limiter: a look-ahead delay of DL frames, and the minimum required gain
  // over a window of DL + 1 frames. The window spans [now - DL, now], so the
  // sample leaving the delay line (index now - DL) is always inside it.
  var LA = Math.max(1, Math.round(0.005 * SR));
  var DL = LA + 1;
  var limBufL = new Float32Array(DL), limBufR = new Float32Array(DL), limPos = 0;
  var QN = DL + 2;
  var dqIdx = new Float64Array(QN), dqVal = new Float64Array(QN), dqHead = 0, dqTail = 0, limN = 0;
  var limOn = false, limCeil = 1, limRel = 0, limGain = 1;

  var bypass = false;
  var mIn = 0, mOut = 0, mRed = 0;

  function configure(fx: AudioFx) {
    bypass = !fx.enabled;
    inGainT = dbToGain(fx.inputGainDb);
    outGainT = dbToGain(fx.outputGainDb);

    var st = fx.pitch && fx.pitch.enabled ? fx.pitch.semitones : 0;
    var at = fx.autotune;
    var wasOn = psOn, atWasOn = atOn;
    atOn = !!at && at.enabled && at.strength > 0;
    psOn = st !== 0 || atOn;
    psManual = Math.pow(2, st / 12);
    if (atOn) {
      atStrength = Math.min(1, Math.max(0, at.strength));
      atKey = ((Math.round(at.key) % 12) + 12) % 12;
      var steps = AT_SCALES[at.scale] || AT_SCALES.chromatic;
      for (var pc = 0; pc < 12; pc++) atAllowed[pc] = steps.indexOf(pc) >= 0;
      // One-pole smoothing per hop: alpha = 1 - exp(-hop / retune time).
      atAlpha = at.retuneMs <= 0 ? 1 : 1 - Math.exp(-(HOP / SR) / (at.retuneMs / 1000));
    } else {
      atCents = 0; atTarget = -1;
    }
    psRatio = psManual * Math.pow(2, atCents / 1200);
    // A grain lasts as long as a head takes to sweep PSW at this ratio (capped while correcting).
    psGrain = psOn ? grainFor(psRatio) : PSW;
    if ((psOn && !wasOn) || atOn !== atWasOn) psResetHeads();

    hp.on = fx.highpass.enabled;
    designBiquad(hp, "highpass", fx.highpass.freq, Math.SQRT1_2, 0);
    lp.on = fx.lowpass.enabled;
    designBiquad(lp, "lowpass", fx.lowpass.freq, Math.SQRT1_2, 0);

    gateOn = fx.gate.enabled;
    gateThr = dbToGain(fx.gate.thresholdDb);
    gateFloor = dbToGain(fx.gate.rangeDb);
    gateAtt = coefFor(fx.gate.attackMs);
    gateRel = coefFor(fx.gate.releaseMs);

    for (var k = 0; k < eqBands.length; k++) {
      var b = fx.eq.bands[k];
      eqBands[k].on = fx.eq.enabled && !!b && b.gainDb !== 0;
      if (b) designBiquad(eqBands[k], b.type, b.freq, b.q, b.gainDb);
    }

    compOn = fx.compressor.enabled;
    compThr = fx.compressor.thresholdDb;
    compRatio = Math.max(1, fx.compressor.ratio);
    compKnee = Math.max(0, fx.compressor.kneeDb);
    compAtt = coefFor(fx.compressor.attackMs);
    compRel = coefFor(fx.compressor.releaseMs);
    compMakeup = dbToGain(fx.compressor.makeupDb);

    delayOn = fx.delay.enabled;
    delayFrames = Math.min(DMAX - 1, Math.max(1, Math.round((fx.delay.timeMs / 1000) * SR)));
    delayFb = Math.min(0.85, Math.max(0, fx.delay.feedback));
    delayMix = Math.min(1, Math.max(0, fx.delay.mix));
    delayPing = fx.delay.pingPong;

    revOn = fx.reverb.enabled;
    revFb = fx.reverb.roomSize * 0.28 + 0.7;
    revDamp = fx.reverb.damping * 0.4;
    var wet = Math.min(1, Math.max(0, fx.reverb.mix)) * 3;
    revWet1 = wet * (fx.reverb.width / 2 + 0.5);
    revWet2 = wet * ((1 - fx.reverb.width) / 2);
    revDry = 1 - Math.min(1, Math.max(0, fx.reverb.mix));
    revPre = Math.min(PMAX - 1, Math.round((fx.reverb.preDelayMs / 1000) * SR));

    limOn = fx.limiter.enabled;
    limCeil = dbToGain(fx.limiter.ceilingDb);
    limRel = coefFor(fx.limiter.releaseMs);
  }

  function reset() {
    var all = [hp, lp].concat(eqBands);
    for (var i = 0; i < all.length; i++) { all[i].z1[0] = all[i].z1[1] = all[i].z2[0] = all[i].z2[1] = 0; }
    gateEnv = 0; gateGain = 1; gateHold = 0; compGr = 0;
    dBufL.fill(0); dBufR.fill(0); dPos = 0;
    for (var j = 0; j < combsL.length; j++) { combsL[j].buf.fill(0); combsR[j].buf.fill(0); combsL[j].store = combsR[j].store = 0; combsL[j].pos = combsR[j].pos = 0; }
    for (var a = 0; a < apsL.length; a++) { apsL[a].buf.fill(0); apsR[a].buf.fill(0); apsL[a].pos = apsR[a].pos = 0; }
    preL.fill(0); preR.fill(0); prePos = 0;
    psL.fill(0); psR.fill(0); psM.fill(0); psPos = 0;
    det.fill(0); detPos = 0; detHalf = 0; detCount = 0; detPrev = 0; atCents = 0; atTarget = -1; atUnvoiced = 0;
    psRatio = psManual; psGrain = psOn ? grainFor(psRatio) : PSW;
    psResetHeads();
    limBufL.fill(0); limBufR.fill(0); limPos = 0; dqHead = dqTail = 0; limN = 0; limGain = 1;
    inGain = inGainT; outGain = outGainT;
  }

  function process(L: Float32Array, R: Float32Array, frames: number) {
    for (var n = 0; n < frames; n++) {
      var l = L[n], r = R[n];
      var ap = Math.max(Math.abs(l), Math.abs(r));
      if (ap > mIn) mIn = ap;
      if (bypass) { if (ap > mOut) mOut = ap; continue; }

      inGain = inGainT + (inGain - inGainT) * smooth;
      l *= inGain; r *= inGain;

      if (psOn) {
        if (atOn) {
          // Decimate (boxcar average of DEC samples) into the detector's ring buffer.
          detPrev += (l + r) * 0.5;
          if (++detHalf === DEC) { det[detPos] = detPrev / DEC; detPos = (detPos + 1) & (DN - 1); detHalf = 0; detPrev = 0; }
          if (++detCount >= HOP) { detCount = 0; correctPitch(); }
        }
        psL[psPos] = l; psR[psPos] = r; psM[psPos] = l + r;
        var g0 = Math.sin(Math.PI * hdAge[0]); g0 *= g0;
        var g1 = 1 - g0;
        l = psAt(psL, hdD[0]) * g0 + psAt(psL, hdD[1]) * g1;
        r = psAt(psR, hdD[0]) * g0 + psAt(psR, hdD[1]) * g1;
        for (var hh = 0; hh < 2; hh++) {
          hdD[hh] += 1 - psRatio;
          hdAge[hh] += 1 / psGrain;
          if (hdAge[hh] >= 1) { hdAge[hh] -= 1; hdD[hh] = psSplice(1 - hh); }
          if (hdD[hh] < 0) hdD[hh] = 0; else if (hdD[hh] > PSN - 3) hdD[hh] = PSN - 3;
        }
        psPos = psPos + 1 === PSN ? 0 : psPos + 1;
      }

      if (hp.on) { l = runBiquad(hp, l, 0); r = runBiquad(hp, r, 1); }

      if (gateOn) {
        var lvl = Math.max(Math.abs(l), Math.abs(r));
        gateEnv = lvl > gateEnv ? lvl : lvl + (gateEnv - lvl) * gateEnvRel;
        if (gateEnv >= gateThr) gateHold = gateHoldFrames; else if (gateHold > 0) gateHold--;
        var gTarget = gateHold > 0 ? 1 : gateFloor;
        gateGain = gTarget + (gateGain - gTarget) * (gTarget > gateGain ? gateAtt : gateRel);
        l *= gateGain; r *= gateGain;
      }

      for (var k = 0; k < eqBands.length; k++) {
        var f = eqBands[k];
        if (f.on) { l = runBiquad(f, l, 0); r = runBiquad(f, r, 1); }
      }

      if (lp.on) { l = runBiquad(lp, l, 0); r = runBiquad(lp, r, 1); }

      if (compOn) {
        var lvlDb = gainToDb(Math.max(Math.abs(l), Math.abs(r)));
        var over = lvlDb - compThr;
        var target = 0;
        if (compKnee > 0 && 2 * Math.abs(over) <= compKnee) {
          var t = over + compKnee / 2;
          target = ((1 - 1 / compRatio) * t * t) / (2 * compKnee);
        } else if (over > 0) {
          target = over * (1 - 1 / compRatio);
        }
        compGr = target + (compGr - target) * (target > compGr ? compAtt : compRel);
        if (compGr > mRed) mRed = compGr;
        var cg = dbToGain(-compGr) * compMakeup;
        l *= cg; r *= cg;
      }

      if (delayOn) {
        var rp = dPos - delayFrames; if (rp < 0) rp += DMAX;
        var dl = dBufL[rp], dr = dBufR[rp];
        if (delayPing) {
          // Input enters the left line; each repeat crosses to the other side.
          dBufL[dPos] = flush((l + r) * 0.5 + dr * delayFb);
          dBufR[dPos] = flush(dl * delayFb);
        } else {
          dBufL[dPos] = flush(l + dl * delayFb);
          dBufR[dPos] = flush(r + dr * delayFb);
        }
        dPos = dPos + 1 === DMAX ? 0 : dPos + 1;
        l = l * (1 - delayMix) + dl * delayMix;
        r = r * (1 - delayMix) + dr * delayMix;
      }

      if (revOn) {
        preL[prePos] = l; preR[prePos] = r;
        var pp = prePos - revPre; if (pp < 0) pp += PMAX;
        prePos = prePos + 1 === PMAX ? 0 : prePos + 1;
        var input = (preL[pp] + preR[pp]) * 0.015;
        var outL = 0, outR = 0;
        for (var c = 0; c < combsL.length; c++) {
          outL += runComb(combsL[c], input, revFb, revDamp);
          outR += runComb(combsR[c], input, revFb, revDamp);
        }
        for (var a = 0; a < apsL.length; a++) {
          outL = runAllpass(apsL[a], outL);
          outR = runAllpass(apsR[a], outR);
        }
        var nl = l * revDry + outL * revWet1 + outR * revWet2;
        var nr = r * revDry + outR * revWet1 + outL * revWet2;
        l = nl; r = nr;
      }

      outGain = outGainT + (outGain - outGainT) * smooth;
      l *= outGain; r *= outGain;

      if (limOn) {
        // Required gain for the incoming sample, then the minimum over the
        // look-ahead window via a monotonic deque. The output sample is the
        // oldest one in the window, so its gain is already low enough.
        var pk = Math.max(Math.abs(l), Math.abs(r));
        var need = pk > limCeil ? limCeil / pk : 1;
        while (dqTail > dqHead && dqVal[(dqTail - 1) % QN] >= need) dqTail--;
        dqIdx[dqTail % QN] = limN; dqVal[dqTail % QN] = need; dqTail++;
        while (dqIdx[dqHead % QN] < limN - DL) dqHead++;
        var wmin = dqVal[dqHead % QN];
        limN++;
        limGain = wmin < limGain ? wmin : wmin + (limGain - wmin) * limRel;
        var ol = limBufL[limPos], or = limBufR[limPos];
        limBufL[limPos] = l; limBufR[limPos] = r;
        limPos = limPos + 1 === DL ? 0 : limPos + 1;
        l = ol * limGain; r = or * limGain;
        // The guarantee: nothing leaves the engine above the ceiling.
        if (l > limCeil) l = limCeil; else if (l < -limCeil) l = -limCeil;
        if (r > limCeil) r = limCeil; else if (r < -limCeil) r = -limCeil;
        var red = -gainToDb(limGain);
        if (red > mRed) mRed = red;
      }

      L[n] = l; R[n] = r;
      var op = Math.max(Math.abs(l), Math.abs(r));
      if (op > mOut) mOut = op;
    }
  }

  return {
    configure: configure,
    process: process,
    reset: reset,
    latency: function () {
      if (bypass) return 0;
      var ps = !psOn ? 0 : atOn ? DLAG + Math.round(PSK / 2) : Math.round((PSW + PSK) / 2);
      return (limOn ? DL : 0) + ps;
    },
    readMeter: function () {
      var m = { inPeak: mIn, outPeak: mOut, reductionDb: mRed, pitchHz: atOn ? atHz : 0, targetMidi: atOn ? atTarget : -1, correctionCents: atOn ? atCents : 0 };
      mIn = 0; mOut = 0; mRed = 0;
      return m;
    },
    eqResponse: function (freqs: number[]) {
      var out: number[] = [];
      for (var i = 0; i < freqs.length; i++) {
        var db = 0;
        for (var k = 0; k < eqBands.length; k++) if (eqBands[k].on) db += magnitudeDb(eqBands[k], freqs[i]);
        out.push(db);
      }
      return out;
    },
  };
}
