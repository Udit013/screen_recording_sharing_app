"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useScreenRecording } from "@/lib/hooks/useScreenRecording";
import {
  hasRecoverableRecording,
  clearRecordingChunks,
} from "@/lib/recordingStore";
import { formatDuration } from "@/lib/utils";
import { ICONS } from "@/constants";

const PIP_POSITIONS: Array<{ value: PipPosition; label: string }> = [
  { value: "br", label: "Bottom right" },
  { value: "bl", label: "Bottom left" },
  { value: "tr", label: "Top right" },
  { value: "tl", label: "Top left" },
];

const RecordScreen = () => {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [withMic, setWithMic] = useState(true);
  const [withCamera, setWithCamera] = useState(false);
  const [pipPosition, setPipPosition] = useState<PipPosition>("br");
  const [pipShape, setPipShape] = useState<PipShape>("circle");
  const [pipSize, setPipSize] = useState<PipSize>("md");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [canRecover, setCanRecover] = useState(false);

  const {
    isRecording,
    isPaused,
    elapsedSeconds,
    recordedBlob,
    recordedVideoUrl,
    recordingDuration,
    transcriptSegments,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    resetRecording,
    restoreRecording,
  } = useScreenRecording();

  // Offer crash recovery when the modal opens with orphaned chunks present.
  useEffect(() => {
    if (!isOpen) return;
    hasRecoverableRecording().then(setCanRecover);
  }, [isOpen]);

  const closeModal = () => {
    if (isRecording) return; // stop first — prevents silent data loss
    setCountdown(null);
    resetRecording();
    setIsOpen(false);
  };

  const beginCountdown = () => {
    if (countdown !== null || isRecording) return;
    setCountdown(3);
  };

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      setCountdown(null);
      setCanRecover(false);
      startRecording({ withMic, withCamera, pipPosition, pipShape, pipSize });
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c ?? 1) - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, startRecording, withMic, withCamera, pipPosition, pipShape, pipSize]);

  // Keyboard shortcuts while the studio is open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape" && !isRecording) closeModal();
      if ((e.key === "p" || e.key === "P") && isRecording) {
        if (isPaused) resumeRecording();
        else pauseRecording();
      }
      if ((e.key === "s" || e.key === "S") && isRecording) stopRecording();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isRecording, isPaused]);

  const recordAgain = () => {
    resetRecording();
    beginCountdown();
  };

  const handleRecover = async () => {
    await restoreRecording();
    setCanRecover(false);
  };

  const handleDiscardRecovery = () => {
    void clearRecordingChunks();
    setCanRecover(false);
  };

  const goToUpload = () => {
    if (!recordedBlob) return;

    const reader = new FileReader();
    reader.onload = () => {
      const arrayBuffer = reader.result as ArrayBuffer;
      const blob = new Blob([arrayBuffer], { type: recordedBlob.type });
      const blobUrl = URL.createObjectURL(blob);

      sessionStorage.setItem(
        "recordedVideo",
        JSON.stringify({
          url: blobUrl,
          name: "screen-recording.webm",
          type: recordedBlob.type,
          size: recordedBlob.size,
          duration: recordingDuration || 0,
          transcriptSegments: transcriptSegments ?? [],
        })
      );
      void clearRecordingChunks();
      router.push("/upload");
      closeModal();
    };
    reader.readAsArrayBuffer(recordedBlob);
  };

  return (
    <div className="record">
      <button onClick={() => setIsOpen(true)} className="primary-btn">
        <Image src={ICONS.record} alt="" width={16} height={16} />
        <span className="truncate">Record a video</span>
      </button>

      {isOpen && (
        <section className="dialog">
          <div className="overlay-record" onClick={closeModal} />
          <div className="dialog-content studio">
            <figure>
              <h3>Recording Studio</h3>
              <button onClick={closeModal} aria-label="Close recording studio">
                <Image src={ICONS.close} alt="" width={20} height={20} />
              </button>
            </figure>

            {canRecover && !isRecording && !recordedVideoUrl && (
              <div className="recovery-banner">
                <p>
                  An unsaved recording from a previous session was found.
                </p>
                <div className="recovery-actions">
                  <button onClick={handleRecover} className="recovery-restore">
                    Restore
                  </button>
                  <button
                    onClick={handleDiscardRecovery}
                    className="recovery-discard"
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}

            <section className="studio-stage">
              {countdown !== null ? (
                <div className="countdown-overlay" aria-live="assertive">
                  <span key={countdown} className="countdown-number">
                    {countdown === 0 ? "Go" : countdown}
                  </span>
                </div>
              ) : isRecording ? (
                <div className="recording-live">
                  <span
                    className={
                      isPaused ? "recording-dot paused" : "recording-dot"
                    }
                  />
                  <span className="recording-timer">
                    {formatDuration(elapsedSeconds) || "0:00"}
                  </span>
                  <span className="recording-status">
                    {isPaused ? "Paused" : "Recording"}
                  </span>
                </div>
              ) : recordedVideoUrl ? (
                <video ref={videoRef} src={recordedVideoUrl} controls />
              ) : (
                <p className="studio-hint">
                  Choose your sources, then hit Record. You&apos;ll get a 3-second
                  countdown.
                </p>
              )}
            </section>

            {!isRecording && !recordedVideoUrl && countdown === null && (
              <div className="studio-options">
                <div className="studio-toggles">
                  <label className="camera-toggle">
                    <input
                      type="checkbox"
                      checked={withMic}
                      onChange={(e) => setWithMic(e.target.checked)}
                    />
                    <span>Microphone (enables auto-transcript)</span>
                  </label>
                  <label className="camera-toggle">
                    <input
                      type="checkbox"
                      checked={withCamera}
                      onChange={(e) => setWithCamera(e.target.checked)}
                    />
                    <span>Webcam overlay</span>
                  </label>
                </div>

                {withCamera && (
                  <div className="pip-options">
                    <div className="pip-group">
                      <span className="pip-label">Position</span>
                      <div className="pip-pills">
                        {PIP_POSITIONS.map((p) => (
                          <button
                            key={p.value}
                            className={pipPosition === p.value ? "active" : ""}
                            onClick={() => setPipPosition(p.value)}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="pip-group">
                      <span className="pip-label">Shape</span>
                      <div className="pip-pills">
                        <button
                          className={pipShape === "circle" ? "active" : ""}
                          onClick={() => setPipShape("circle")}
                        >
                          Circle
                        </button>
                        <button
                          className={pipShape === "rounded" ? "active" : ""}
                          onClick={() => setPipShape("rounded")}
                        >
                          Rounded
                        </button>
                      </div>
                    </div>
                    <div className="pip-group">
                      <span className="pip-label">Size</span>
                      <div className="pip-pills">
                        {(["sm", "md", "lg"] as PipSize[]).map((s) => (
                          <button
                            key={s}
                            className={pipSize === s ? "active" : ""}
                            onClick={() => setPipSize(s)}
                          >
                            {s.toUpperCase()}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="record-box">
              {!isRecording && !recordedVideoUrl && countdown === null && (
                <button onClick={beginCountdown} className="record-start">
                  <Image src={ICONS.record} alt="" width={16} height={16} />
                  Record
                </button>
              )}
              {isRecording && (
                <>
                  <button
                    onClick={isPaused ? resumeRecording : pauseRecording}
                    className="record-pause"
                  >
                    {isPaused ? "Resume" : "Pause"}
                  </button>
                  <button onClick={stopRecording} className="record-stop">
                    <Image src={ICONS.record} alt="" width={16} height={16} />
                    Stop
                  </button>
                </>
              )}
              {recordedVideoUrl && (
                <>
                  <button onClick={recordAgain} className="record-again">
                    Record Again
                  </button>
                  <button onClick={goToUpload} className="record-upload">
                    <Image src={ICONS.upload} alt="" width={16} height={16} />
                    Continue to Upload
                  </button>
                </>
              )}
            </div>

            {isRecording && (
              <p className="studio-shortcuts">
                <kbd>P</kbd> pause / resume · <kbd>S</kbd> stop
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
};

export default RecordScreen;
