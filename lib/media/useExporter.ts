"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Range } from "./edl";
import type { ExportEvent, ExportPreset, ExportRequest } from "./export-presets";

export type ExporterState =
  | { phase: "idle" }
  | { phase: "preparing" }
  | {
      phase: "rendering";
      fraction: number;
      width: number;
      height: number;
      videoCodec: string;
      audioCodec: string | null;
      editedSeconds: number;
    }
  | {
      phase: "done";
      url: string;
      bytes: number;
      ms: number;
      width: number;
      height: number;
      videoCodec: string;
      audioCodec: string | null;
      editedSeconds: number;
    }
  | { phase: "error"; message: string };

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

  const start = useCallback((url: string, segments: Range[], preset: ExportPreset) => {
    workerRef.current?.terminate();
    releaseUrl();
    const worker = new Worker(new URL("./export.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    setState({ phase: "preparing" });

    let info: Extract<ExportEvent, { type: "start" }> | null = null;
    worker.onmessage = (e: MessageEvent<ExportEvent>) => {
      const m = e.data;
      if (m.type === "start") {
        info = m;
        setState({ phase: "rendering", fraction: 0, ...m });
      } else if (m.type === "progress" && info) {
        setState({ phase: "rendering", fraction: m.fraction, ...info });
      } else if (m.type === "done" && info) {
        const blob = new Blob([m.buffer], { type: "video/mp4" });
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
    const req: ExportRequest = { type: "export", url: absolute, segments, preset };
    worker.postMessage(req);
  }, []);

  return { state, start, reset };
}
