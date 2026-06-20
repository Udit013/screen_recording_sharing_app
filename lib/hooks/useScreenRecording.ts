import { useState, useRef, useEffect, useCallback } from "react";
import {
  getMediaStreams,
  createAudioMixer,
  cleanupRecording,
  createRecordingBlob,
  calculateRecordingDuration,
} from "@/lib/utils";
import { DEFAULT_RECORDING_CONFIG } from "@/constants";
import { createTranscriber, type Transcriber } from "@/lib/speech";

export const useScreenRecording = () => {
  const [state, setState] = useState<ScreenRecordingState>({
    isRecording: false,
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
  const animFrameRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const transcriberRef = useRef<Transcriber | null>(null);

  const cleanup = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    transcriberRef.current?.stop();
    cleanupRecording(
      mediaRecorderRef.current,
      streamRef.current,
      streamRef.current?._originalStreams
    );
    audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;
    streamRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      cleanup();
      if (state.recordedVideoUrl) URL.revokeObjectURL(state.recordedVideoUrl);
    };
  }, []); // only on unmount

  const handleRecordingStop = useCallback(() => {
    const { blob, url } = createRecordingBlob(chunksRef.current);
    const duration = calculateRecordingDuration(startTimeRef.current);
    transcriberRef.current?.stop();
    const segments = transcriberRef.current?.getSegments() ?? [];
    setState((prev) => ({
      ...prev,
      recordedBlob: blob,
      recordedVideoUrl: url,
      recordingDuration: duration,
      transcriptSegments: segments,
      isRecording: false,
    }));
  }, []);

  const startRecording = useCallback(async (withMic = true, withCamera = false) => {
    try {
      cleanup();
      chunksRef.current = [];

      const { displayStream, micStream, cameraStream, hasDisplayAudio } =
        await getMediaStreams(withMic, withCamera);

      let recordingStream: MediaStream;

      if (withCamera && cameraStream) {
        // Composite screen + webcam PiP on canvas
        const canvas = document.createElement("canvas");
        canvas.width = 1920;
        canvas.height = 1080;
        canvasRef.current = canvas;
        const ctx = canvas.getContext("2d")!;

        const screenVideo = document.createElement("video");
        screenVideo.srcObject = displayStream;
        screenVideo.muted = true;
        await screenVideo.play();

        const camVideo = document.createElement("video");
        camVideo.srcObject = cameraStream;
        camVideo.muted = true;
        await camVideo.play();

        const PIP_SIZE = 240;
        const PIP_MARGIN = 24;
        const PIP_X = canvas.width - PIP_SIZE - PIP_MARGIN;
        const PIP_Y = canvas.height - PIP_SIZE - PIP_MARGIN;
        const PIP_RADIUS = PIP_SIZE / 2;

        let running = true;
        const draw = () => {
          if (!running) return;
          ctx.drawImage(screenVideo, 0, 0, canvas.width, canvas.height);

          // Draw circular webcam PiP
          ctx.save();
          ctx.beginPath();
          ctx.arc(PIP_X + PIP_RADIUS, PIP_Y + PIP_RADIUS, PIP_RADIUS, 0, Math.PI * 2);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(camVideo, PIP_X, PIP_Y, PIP_SIZE, PIP_SIZE);
          ctx.restore();

          // White border
          ctx.beginPath();
          ctx.arc(PIP_X + PIP_RADIUS, PIP_Y + PIP_RADIUS, PIP_RADIUS, 0, Math.PI * 2);
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 4;
          ctx.stroke();

          animFrameRef.current = requestAnimationFrame(draw);
        };
        draw();

        const canvasStream = canvas.captureStream(30) as ExtendedMediaStream;
        audioContextRef.current = new AudioContext();
        const audioDest = createAudioMixer(audioContextRef.current, displayStream, micStream, hasDisplayAudio);

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

        // Stop canvas loop when streams end
        displayStream.getVideoTracks()[0]?.addEventListener("ended", () => { running = false; });
      } else {
        // Screen-only recording
        const combinedStream = new MediaStream() as ExtendedMediaStream;
        displayStream.getVideoTracks().forEach((t) => combinedStream.addTrack(t));

        audioContextRef.current = new AudioContext();
        const audioDest = createAudioMixer(audioContextRef.current, displayStream, micStream, hasDisplayAudio);
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

      recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      recorder.onstop = handleRecordingStop;

      mediaRecorderRef.current = recorder;
      startTimeRef.current = Date.now();
      recorder.start(1000);

      // Capture a timestamped transcript from narration (Chrome/Edge only).
      if (withMic) {
        const transcriber = createTranscriber(() =>
          startTimeRef.current ? (Date.now() - startTimeRef.current) / 1000 : 0
        );
        transcriberRef.current = transcriber;
        if (transcriber.supported) transcriber.start();
      }

      setState((prev) => ({ ...prev, isRecording: true, transcriptSegments: [] }));
      return true;
    } catch (error) {
      console.error("Recording error:", error);
      return false;
    }
  }, [cleanup, handleRecordingStop]);

  const stopRecording = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    transcriberRef.current?.stop();
    cleanupRecording(
      mediaRecorderRef.current,
      streamRef.current,
      streamRef.current?._originalStreams
    );
    streamRef.current = null;
    setState((prev) => ({ ...prev, isRecording: false }));
  }, []);

  const resetRecording = useCallback(() => {
    stopRecording();
    setState((prev) => {
      if (prev.recordedVideoUrl) URL.revokeObjectURL(prev.recordedVideoUrl);
      return {
        isRecording: false,
        recordedBlob: null,
        recordedVideoUrl: "",
        recordingDuration: 0,
        transcriptSegments: [],
      };
    });
    transcriberRef.current = null;
    startTimeRef.current = null;
    chunksRef.current = [];
  }, [stopRecording]);

  return { ...state, startRecording, stopRecording, resetRecording };
};
