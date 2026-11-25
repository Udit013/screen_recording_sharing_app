import { useState, useRef, useEffect, useCallback } from "react";
import {
  getMediaStreams,
  createAudioMixer,
  cleanupRecording,
  createRecordingBlob,
} from "@/lib/utils";
import { DEFAULT_RECORDING_CONFIG } from "@/constants";
import { createTranscriber, type Transcriber } from "@/lib/speech";
import { finalizeRecording } from "@/lib/media/finalizeRecording";
import {
  appendRecordingChunk,
  getRecoverableChunks,
  clearRecordingChunks,
} from "@/lib/recordingStore";

const PIP_SIZES: Record<PipSize, number> = { sm: 160, md: 240, lg: 320 };
/** Longest side of the composited recording; the screen's own aspect ratio is kept. */
const MAX_CANVAS_SIDE = 1920;

/**
 * Canvas size for compositing a screen of `w`×`h`: same aspect ratio (a fixed
 * 1920×1080 canvas stretched 16:10 Mac screens sideways), long side at most
 * MAX_CANVAS_SIDE, even numbers for the encoder.
 */
export function compositeSize(w: number, h: number): { width: number; height: number } {
  if (!(w > 0) || !(h > 0)) return { width: 1920, height: 1080 };
  const scale = Math.min(1, MAX_CANVAS_SIDE / Math.max(w, h));
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(w), height: even(h) };
}

/** Draws the screen "contain"-fitted, so a mid-recording switch to a differently shaped window letterboxes instead of distorting. */
function drawContain(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, cw: number, ch: number) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.min(cw / vw, ch / vh);
  const dw = vw * scale, dh = vh * scale;
  if (dw < cw - 0.5 || dh < ch - 0.5) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cw, ch); }
  ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
}
const PIP_MARGIN = 24;

// requestAnimationFrame is suspended entirely while the tab is hidden, which
// would freeze the canvas compositor the moment the user switches tabs.
// Worker timers are not throttled that way, so a tiny inline worker drives
// the draw loop at ~30fps regardless of tab visibility.
function createTickerWorker(onTick: () => void): Worker | null {
  if (typeof Worker === "undefined") return null;
  try {
    const src = `let id=null;onmessage=(e)=>{if(e.data==="start"&&id===null){id=setInterval(()=>postMessage(0),33);}else if(e.data==="stop"&&id!==null){clearInterval(id);id=null;}};`;
    const worker = new Worker(
      URL.createObjectURL(new Blob([src], { type: "application/javascript" }))
    );
    worker.onmessage = onTick;
    worker.postMessage("start");
    return worker;
  } catch {
    return null;
  }
}

// Draws `video` into the destination rect with cover-fit (center crop, no
// distortion), matching how Loom renders the camera bubble.
function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number
) {
  const vw = video.videoWidth || dw;
  const vh = video.videoHeight || dh;
  const scale = Math.max(dw / vw, dh / vh);
  const sw = dw / scale;
  const sh = dh / scale;
  const sx = (vw - sw) / 2;
  const sy = (vh - sh) / 2;
  ctx.drawImage(video, sx, sy, sw, sh, dx, dy, dw, dh);
}

export const useScreenRecording = () => {
  const [state, setState] = useState<ScreenRecordingState>({
    isRecording: false,
    isPaused: false,
    elapsedSeconds: 0,
    recordedBlob: null,
    recordedVideoUrl: "",
    recordingDuration: 0,
    transcriptSegments: [],
  });

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<ExtendedMediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const pausedTotalRef = useRef(0);
  const pausedAtRef = useRef<number | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const tickerWorkerRef = useRef<Worker | null>(null);
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transcriberRef = useRef<Transcriber | null>(null);

  // Elapsed wall-clock seconds excluding paused stretches.
  const getElapsed = useCallback((): number => {
    if (!startTimeRef.current) return 0;
    const pausedNow = pausedAtRef.current
      ? Date.now() - pausedAtRef.current
      : 0;
    return Math.max(
      0,
      (Date.now() - startTimeRef.current - pausedTotalRef.current - pausedNow) /
        1000
    );
  }, []);

  const stopTicker = useCallback(() => {
    if (tickIntervalRef.current) {
      clearInterval(tickIntervalRef.current);
      tickIntervalRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (tickerWorkerRef.current) {
      tickerWorkerRef.current.postMessage("stop");
      tickerWorkerRef.current.terminate();
      tickerWorkerRef.current = null;
    }
    stopTicker();
    transcriberRef.current?.stop();
    cleanupRecording(
      mediaRecorderRef.current,
      streamRef.current,
      streamRef.current?._originalStreams
    );
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    streamRef.current = null;
  }, [stopTicker]);

  useEffect(() => {
    return () => {
      cleanup();
      if (state.recordedVideoUrl) URL.revokeObjectURL(state.recordedVideoUrl);
    };
    // Intentionally runs only on unmount — re-running on state change would
    // revoke the blob URL while the preview is still playing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleRecordingStop = useCallback(async () => {
    const duration = Math.round(getElapsed());
    stopTicker();
    transcriberRef.current?.stop();
    const segments = transcriberRef.current?.getSegments() ?? [];
    // Write the duration and seek index MediaRecorder leaves out (see finalizeRecording).
    const raw = createRecordingBlob(chunksRef.current);
    const blob = await finalizeRecording(raw.blob);
    let url = raw.url;
    if (blob !== raw.blob) { URL.revokeObjectURL(raw.url); url = URL.createObjectURL(blob); }
    setState((prev) => ({
      ...prev,
      recordedBlob: blob,
      recordedVideoUrl: url,
      recordingDuration: duration,
      transcriptSegments: segments,
      isRecording: false,
      isPaused: false,
    }));
  }, [getElapsed, stopTicker]);

  const startRecording = useCallback(
    async (options: RecordingOptions) => {
      const { withMic, withCamera, pipPosition, pipShape, pipSize } = options;
      try {
        cleanup();
        chunksRef.current = [];
        pausedTotalRef.current = 0;
        pausedAtRef.current = null;
        await clearRecordingChunks();

        const { displayStream, micStream, cameraStream, hasDisplayAudio } =
          await getMediaStreams(withMic, withCamera);

        let recordingStream: MediaStream;

        if (withCamera && cameraStream) {
          // Composite screen + webcam PiP on a canvas.
          const screenVideo = document.createElement("video");
          screenVideo.srcObject = displayStream;
          screenVideo.muted = true;
          await screenVideo.play();

          // Match the shared screen's shape instead of forcing 16:9.
          const canvas = document.createElement("canvas");
          const dims = compositeSize(screenVideo.videoWidth, screenVideo.videoHeight);
          canvas.width = dims.width;
          canvas.height = dims.height;
          const ctx = canvas.getContext("2d")!;

          const camVideo = document.createElement("video");
          camVideo.srcObject = cameraStream;
          camVideo.muted = true;
          await camVideo.play();

          // Bubble sizes were tuned for a 1080-high frame; keep that proportion.
          const size = Math.round(PIP_SIZES[pipSize] * (Math.min(canvas.width, canvas.height) / 1080));
          const pipW = size;
          const pipH = pipShape === "circle" ? size : Math.round(size * 0.62);
          const pipX = pipPosition.includes("l")
            ? PIP_MARGIN
            : canvas.width - pipW - PIP_MARGIN;
          const pipY = pipPosition.includes("t")
            ? PIP_MARGIN
            : canvas.height - pipH - PIP_MARGIN;

          let running = true;
          const draw = () => {
            if (!running) return;
            drawContain(ctx, screenVideo, canvas.width, canvas.height);

            ctx.save();
            ctx.beginPath();
            if (pipShape === "circle") {
              const r = pipW / 2;
              ctx.arc(pipX + r, pipY + r, r, 0, Math.PI * 2);
            } else {
              ctx.roundRect(pipX, pipY, pipW, pipH, 16);
            }
            ctx.closePath();
            ctx.clip();
            drawCover(ctx, camVideo, pipX, pipY, pipW, pipH);
            ctx.restore();

            ctx.beginPath();
            if (pipShape === "circle") {
              const r = pipW / 2;
              ctx.arc(pipX + r, pipY + r, r, 0, Math.PI * 2);
            } else {
              ctx.roundRect(pipX, pipY, pipW, pipH, 16);
            }
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 4;
            ctx.stroke();
          };

          // Worker-driven ticks keep compositing while this tab is hidden;
          // fall back to a rAF loop if workers are unavailable.
          const worker = createTickerWorker(draw);
          if (worker) {
            tickerWorkerRef.current = worker;
          } else {
            const rafLoop = () => {
              if (!running) return;
              draw();
              animFrameRef.current = requestAnimationFrame(rafLoop);
            };
            rafLoop();
          }

          const canvasStream = canvas.captureStream(30) as ExtendedMediaStream;
          audioContextRef.current = new AudioContext();
          const audioDest = createAudioMixer(
            audioContextRef.current,
            displayStream,
            micStream,
            hasDisplayAudio
          );

          const finalStream = new MediaStream([
            ...canvasStream.getVideoTracks(),
            ...(audioDest ? audioDest.stream.getAudioTracks() : []),
          ]) as ExtendedMediaStream;

          finalStream._originalStreams = [
            displayStream,
            cameraStream,
            ...(micStream ? [micStream] : []),
          ];

          streamRef.current = finalStream;
          recordingStream = finalStream;

          displayStream.getVideoTracks()[0]?.addEventListener("ended", () => {
            running = false;
            tickerWorkerRef.current?.postMessage("stop");
          });
        } else {
          const combinedStream = new MediaStream() as ExtendedMediaStream;
          displayStream.getVideoTracks().forEach((t) => combinedStream.addTrack(t));

          audioContextRef.current = new AudioContext();
          const audioDest = createAudioMixer(
            audioContextRef.current,
            displayStream,
            micStream,
            hasDisplayAudio
          );
          audioDest?.stream.getAudioTracks().forEach((t) => combinedStream.addTrack(t));

          combinedStream._originalStreams = [
            displayStream,
            ...(micStream ? [micStream] : []),
          ];

          streamRef.current = combinedStream;
          recordingStream = combinedStream;
        }

        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(recordingStream, DEFAULT_RECORDING_CONFIG);
        } catch {
          recorder = new MediaRecorder(recordingStream);
        }

        recorder.ondataavailable = (e) => {
          if (e.data.size) {
            chunksRef.current.push(e.data);
            // Persist for crash recovery (best-effort, off the hot path).
            void appendRecordingChunk(e.data);
          }
        };
        recorder.onstop = handleRecordingStop;

        mediaRecorderRef.current = recorder;
        startTimeRef.current = Date.now();
        recorder.start(1000);

        if (withMic) {
          const transcriber = createTranscriber(getElapsed);
          transcriberRef.current = transcriber;
          if (transcriber.supported) transcriber.start();
        }

        stopTicker();
        tickIntervalRef.current = setInterval(() => {
          setState((prev) =>
            prev.isRecording
              ? { ...prev, elapsedSeconds: Math.floor(getElapsed()) }
              : prev
          );
        }, 500);

        setState((prev) => ({
          ...prev,
          isRecording: true,
          isPaused: false,
          elapsedSeconds: 0,
          transcriptSegments: [],
        }));
        return true;
      } catch (error) {
        console.error("Recording error:", error);
        return false;
      }
    },
    [cleanup, handleRecordingStop, getElapsed, stopTicker]
  );

  const pauseRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    recorder.pause();
    pausedAtRef.current = Date.now();
    transcriberRef.current?.stop();
    setState((prev) => ({ ...prev, isPaused: true }));
  }, []);

  const resumeRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== "paused") return;
    recorder.resume();
    if (pausedAtRef.current) {
      pausedTotalRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
    }
    transcriberRef.current?.start();
    setState((prev) => ({ ...prev, isPaused: false }));
  }, []);

  const stopRecording = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (tickerWorkerRef.current) {
      tickerWorkerRef.current.postMessage("stop");
      tickerWorkerRef.current.terminate();
      tickerWorkerRef.current = null;
    }
    // Close the paused gap so the final duration is correct.
    if (pausedAtRef.current) {
      pausedTotalRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
    }
    transcriberRef.current?.stop();
    cleanupRecording(
      mediaRecorderRef.current,
      streamRef.current,
      streamRef.current?._originalStreams
    );
    streamRef.current = null;
    setState((prev) => ({ ...prev, isRecording: false, isPaused: false }));
  }, []);

  const resetRecording = useCallback(() => {
    stopRecording();
    stopTicker();
    void clearRecordingChunks();
    setState((prev) => {
      if (prev.recordedVideoUrl) URL.revokeObjectURL(prev.recordedVideoUrl);
      return {
        isRecording: false,
        isPaused: false,
        elapsedSeconds: 0,
        recordedBlob: null,
        recordedVideoUrl: "",
        recordingDuration: 0,
        transcriptSegments: [],
      };
    });
    transcriberRef.current = null;
    startTimeRef.current = null;
    pausedTotalRef.current = 0;
    pausedAtRef.current = null;
    chunksRef.current = [];
  }, [stopRecording, stopTicker]);

  // Rebuilds a recording from chunks persisted before a crash or refresh.
  const restoreRecording = useCallback(async (): Promise<boolean> => {
    const chunks = await getRecoverableChunks();
    if (chunks.length === 0) return false;
    const raw = createRecordingBlob(chunks);
    const blob = await finalizeRecording(raw.blob);
    let url = raw.url;
    if (blob !== raw.blob) { URL.revokeObjectURL(raw.url); url = URL.createObjectURL(blob); }
    setState((prev) => {
      if (prev.recordedVideoUrl) URL.revokeObjectURL(prev.recordedVideoUrl);
      return {
        ...prev,
        isRecording: false,
        isPaused: false,
        recordedBlob: blob,
        recordedVideoUrl: url,
        // Chunks arrive roughly once per second of recording.
        recordingDuration: chunks.length,
        transcriptSegments: [],
      };
    });
    return true;
  }, []);

  return {
    ...state,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    resetRecording,
    restoreRecording,
  };
};
