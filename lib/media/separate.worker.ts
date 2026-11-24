/// <reference lib="webworker" />
// Vocal / instrumental separation (Spleeter 2-stems, ONNX, int8) in a worker
// with onnxruntime-web on WebAssembly. Models (~2 × 26 MB) download once from
// Hugging Face and are kept in Cache Storage; nothing is uploaded.
// Also encodes stems / remixes to the user's chosen format on request.

import * as ort from "onnxruntime-web";
import { separate } from "@/lib/studio/separate";
import { encodeAudioFile } from "./audioEncoder";
import type { AudioFormatId } from "./audioFormats";

export const SEPARATION_MODEL = {
  name: "Spleeter 2-stems (Deezer, MIT), ONNX int8 export by sherpa-onnx (Apache-2.0)",
  urls: {
    vocals: "https://huggingface.co/csukuangfj/sherpa-onnx-spleeter-2stems-int8/resolve/main/vocals.int8.onnx",
    accompaniment: "https://huggingface.co/csukuangfj/sherpa-onnx-spleeter-2stems-int8/resolve/main/accompaniment.int8.onnx",
  },
  approxMB: 52,
};
const CACHE = "snapcast-models-v1";

export type SeparateRequest =
  | { type: "separate"; left: Float32Array; right: Float32Array }
  | { type: "encode"; left: Float32Array; right: Float32Array; sampleRate: number; format: AudioFormatId; kbps: number };

export type SeparateEvent =
  | { type: "model"; loaded: number; total: number; cached: boolean }
  | { type: "progress"; fraction: number }
  | { type: "stems"; vocals: [Float32Array, Float32Array]; accompaniment: [Float32Array, Float32Array]; ms: number }
  | { type: "encoded"; buffer: ArrayBuffer }
  | { type: "error"; message: string };

const post = (e: SeparateEvent, t: Transferable[] = []) => (self as unknown as Worker).postMessage(e, t);

// Same onnxruntime-web build transformers.js uses, so the WASM is shared in the browser cache.
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let sessions: Record<"vocals" | "accompaniment", ort.InferenceSession> | null = null;

/** Fetches a model, from Cache Storage when present, reporting download progress. */
async function fetchModel(url: string, onBytes: (loaded: number, total: number, cached: boolean) => void): Promise<ArrayBuffer> {
  const cache = typeof caches !== "undefined" ? await caches.open(CACHE).catch(() => null) : null;
  const hit = await cache?.match(url);
  if (hit) {
    const b = await hit.arrayBuffer();
    onBytes(b.byteLength, b.byteLength, true);
    return b;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Couldn't download the separation model (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onBytes(loaded, total, false);
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  await cache?.put(url, new Response(out.slice().buffer, { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
  return out.buffer;
}

async function load() {
  if (sessions) return sessions;
  const progress = { vocals: [0, 0], accompaniment: [0, 0] };
  let anyCached = false;
  const report = () => post({
    type: "model",
    loaded: progress.vocals[0] + progress.accompaniment[0],
    total: progress.vocals[1] + progress.accompaniment[1],
    cached: anyCached,
  });
  const get = (stem: "vocals" | "accompaniment") =>
    fetchModel(SEPARATION_MODEL.urls[stem], (l, t, c) => { progress[stem] = [l, t]; anyCached ||= c; report(); });
  const [v, a] = await Promise.all([get("vocals"), get("accompaniment")]);
  const opts: ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  sessions = {
    vocals: await ort.InferenceSession.create(new Uint8Array(v), opts),
    accompaniment: await ort.InferenceSession.create(new Uint8Array(a), opts),
  };
  return sessions;
}

self.onmessage = async (msg: MessageEvent<SeparateRequest>) => {
  try {
    if (msg.data.type === "encode") {
      const { left, right, sampleRate, format, kbps } = msg.data;
      const buffer = await encodeAudioFile(format, kbps, sampleRate, async (push) => {
        for (let i = 0; i < left.length; i += 44100) {
          const n = Math.min(44100, left.length - i);
          await push(left.subarray(i, i + n), right.subarray(i, i + n), n, i / sampleRate);
        }
      });
      post({ type: "encoded", buffer }, [buffer]);
      return;
    }
    const s = await load();
    const t0 = performance.now();
    const stems = await separate(msg.data.left, msg.data.right, async (stem, x, dims) => {
      const r = await s[stem].run({ x: new ort.Tensor("float32", x, dims) });
      return r.y.data as Float32Array;
    }, (f) => post({ type: "progress", fraction: f }));
    const t = [stems.vocals[0].buffer, stems.vocals[1].buffer, stems.accompaniment[0].buffer, stems.accompaniment[1].buffer] as ArrayBuffer[];
    post({ type: "stems", vocals: stems.vocals, accompaniment: stems.accompaniment, ms: performance.now() - t0 }, t);
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
