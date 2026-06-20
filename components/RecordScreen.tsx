"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useScreenRecording } from "@/lib/hooks/useScreenRecording";
import { ICONS } from "@/constants";

const RecordScreen = () => {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [withCamera, setWithCamera] = useState(false);
  const [recordingBlobRef] = useState<{ blob: Blob | null }>({ blob: null });

  const {
    isRecording,
    recordedBlob,
    recordedVideoUrl,
    recordingDuration,
    transcriptSegments,
    startRecording,
    stopRecording,
    resetRecording,
  } = useScreenRecording();

  const closeModal = () => {
    resetRecording();
    setIsOpen(false);
  };

  const handleStart = async () => {
    await startRecording(true, withCamera);
  };

  const recordAgain = async () => {
    resetRecording();
    await startRecording(true, withCamera);
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
      router.push("/upload");
      closeModal();
    };
    reader.readAsArrayBuffer(recordedBlob);
  };

  return (
    <div className="record">
      <button onClick={() => setIsOpen(true)} className="primary-btn">
        <Image src={ICONS.record} alt="record" width={16} height={16} />
        <span className="truncate">Record a video</span>
      </button>

      {isOpen && (
        <section className="dialog">
          <div className="overlay-record" onClick={closeModal} />
          <div className="dialog-content">
            <figure>
              <h3>Screen Recording</h3>
              <button onClick={closeModal}>
                <Image src={ICONS.close} alt="Close" width={20} height={20} />
              </button>
            </figure>

            <section>
              {isRecording ? (
                <article>
                  <div />
                  <span>Recording in progress…</span>
                </article>
              ) : recordedVideoUrl ? (
                <video ref={videoRef} src={recordedVideoUrl} controls />
              ) : (
                <p>Click Record to start capturing your screen.</p>
              )}
            </section>

            {!isRecording && !recordedVideoUrl && (
              <label className="camera-toggle">
                <input
                  type="checkbox"
                  checked={withCamera}
                  onChange={(e) => setWithCamera(e.target.checked)}
                />
                <span>Include webcam (picture-in-picture)</span>
              </label>
            )}

            <div className="record-box">
              {!isRecording && !recordedVideoUrl && (
                <button onClick={handleStart} className="record-start">
                  <Image src={ICONS.record} alt="record" width={16} height={16} />
                  Record
                </button>
              )}
              {isRecording && (
                <button onClick={stopRecording} className="record-stop">
                  <Image src={ICONS.record} alt="stop" width={16} height={16} />
                  Stop Recording
                </button>
              )}
              {recordedVideoUrl && (
                <>
                  <button onClick={recordAgain} className="record-again">
                    Record Again
                  </button>
                  <button onClick={goToUpload} className="record-upload">
                    <Image src={ICONS.upload} alt="Upload" width={16} height={16} />
                    Continue to Upload
                  </button>
                </>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
};

export default RecordScreen;
