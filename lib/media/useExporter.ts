"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Range } from "./edl";
import type { ExportEvent, ExportOutput, ExportPreset, ExportRequest } from "./export-presets";
import type { AudioFx } from "@/lib/studio/fx";

type StartInfo = Omit<Extract<ExportEvent, { type: "start" }>, "type">;

export type ExporterState =
  | { phase: "idle" }
  | { phase: "preparing" }
  | ({ phase: "rendering"; fraction: number } & StartInfo)
  | ({ phase: "done"; url: string; bytes: number; ms: number } & StartInfo)
  | { phase: "error"; message: string };

export interface ExportOptions {
  audioFx?: AudioFx | null;
  output?: ExportOutput;
  captions?: ExportRequest["captions"];
  look?: ExportRequest["look"];
}

/** Renders an edit in a worker. Object URLs are revoked on reset/unmount. */
export function useExporter() {
  const [state, setState] = useState<ExporterState>({ phase: "idle" });
  const workerRef = useRef<Worker | null>(null);
  const urlRef = useRef<string | null>(null);

  const releaseUrl = () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  };

  const reset = useCallback(() => {
    workerRef.current?.terminate();
    workerRef.current = null;
    releaseUrl();
    setState({ phase: "idle" });
  }, []);

  useEffect(() => () => { workerRef.current?.terminate(); releaseUrl(); }, []);

  const start = useCallback((url: string, segments: Range[], preset: ExportPreset, options: ExportOptions = {}) => {
    workerRef.current?.terminate();
    releaseUrl();
    const worker = new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setState({ phase: "preparing" });

    let info: StartInfo | null = null;
    worker.onmessage = (e: MessageEvent<ExportEvent>) => {
      const m = e.data;
      if (m.type === "start") {
        const { type: _type, ...rest } = m;
        info = rest;
        setState({ phase: "rendering", fraction: 0, ...rest });
      } else if (m.type === "progress" && info) {
        setState({ phase: "rendering", fraction: m.fraction, ...info });
      } else if (m.type === "done" && info) {
        const blob = new Blob([m.buffer], { type: info.output === "wav" ? "audio/wav" : "video/mp4" });
        urlRef.current = URL.createObjectURL(blob);
        setState({ phase: "done", url: urlRef.current, bytes: blob.size, ms: m.ms, ...info });
        worker.terminate();
        workerRef.current = null;
      } else if (m.type === "error") {
        setState({ phase: "error", message: m.message });
        worker.terminate();
        workerRef.current = null;
      }
    };
    worker.onerror = (e) => setState({ phase: "error", message: e.message || "The export worker crashed." });

    // Workers can't always resolve relative URLs (e.g. blob-URL workers).
    const absolute = new URL(url, window.location.href).href;
    const req: ExportRequest = {
      type: "export",
      url: absolute,
      segments,
      preset,
      audioFx: options.audioFx ?? null,
      output: options.output ?? "mp4",
      captions: options.captions ?? null,
      look: options.look ?? null,
    };
    worker.postMessage(req);
  }, []);

  return { state, start, reset };
}
