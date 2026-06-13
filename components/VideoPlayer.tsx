"use client";

import { cn, createIframeLink } from "@/lib/utils";
import { useEffect, useRef, useState, useCallback } from "react";
import { incrementVideoViews, getVideoProcessingStatus } from "@/lib/actions/video";
import { initialVideoState } from "@/constants";

const VideoPlayer = ({ videoId, className, onProcessed }: VideoPlayerProps) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState(initialVideoState);
  const [startTime, setStartTime] = useState<number | undefined>(undefined);
  const hasNotifiedProcessed = useRef(false);

  const checkProcessingStatus = useCallback(async () => {
    try {
      const status = await getVideoProcessingStatus(videoId);
      setState((prev) => ({ ...prev, isProcessing: !status.isProcessed }));
      return status.isProcessed;
    } catch {
      return false;
    }
  }, [videoId]);

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval>;

    checkProcessingStatus().then((isProcessed) => {
      if (isProcessed) {
        if (!hasNotifiedProcessed.current) {
          hasNotifiedProcessed.current = true;
          onProcessed?.();
        }
        return;
      }

      intervalId = setInterval(async () => {
        const done = await checkProcessingStatus();
        if (done) {
          clearInterval(intervalId);
          if (!hasNotifiedProcessed.current) {
            hasNotifiedProcessed.current = true;
            onProcessed?.();
          }
        }
      }, 3000);
    });

    return () => clearInterval(intervalId);
  }, [videoId, checkProcessingStatus, onProcessed]);

  useEffect(() => {
    if (state.isLoaded && !state.hasIncrementedView && !state.isProcessing) {
      incrementVideoViews(videoId).catch(console.error);
      setState((prev) => ({ ...prev, hasIncrementedView: true }));
    }
  }, [videoId, state.isLoaded, state.hasIncrementedView, state.isProcessing]);

  const seekTo = (seconds: number) => {
    setStartTime(seconds);
    if (iframeRef.current) {
      iframeRef.current.src = createIframeLink(videoId, seconds);
    }
  };

  return (
    <div className={cn("video-player", className)} id="video-player-container">
      {state.isProcessing ? (
        <div>
          <p>Processing video, please wait…</p>
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={createIframeLink(videoId, startTime)}
          loading="lazy"
          title="Video player"
          style={{ border: 0, zIndex: 50 }}
          allow="accelerometer; gyroscope; autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          onLoad={() => setState((prev) => ({ ...prev, isLoaded: true }))}
        />
      )}
    </div>
  );
};

export default VideoPlayer;
