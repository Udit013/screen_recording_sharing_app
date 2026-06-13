"use client";

import { cn } from "@/lib/utils";
import { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from "react";
import { incrementVideoViews } from "@/lib/actions/video";

export interface VideoPlayerHandle {
  seekTo: (seconds: number) => void;
}

interface VideoPlayerProps {
  videoUrl: string;
  className?: string;
  onReady?: () => void;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ videoUrl, className, onReady }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [hasIncrementedView, setHasIncrementedView] = useState(false);
    const videoId = videoUrl.split("/").pop()?.split(".")[0] ?? "";

    useImperativeHandle(ref, () => ({
      seekTo(seconds: number) {
        if (videoRef.current) {
          videoRef.current.currentTime = seconds;
          videoRef.current.play().catch(() => {});
        }
      },
    }));

    const handleCanPlay = useCallback(() => {
      onReady?.();
    }, [onReady]);

    const handleTimeUpdate = useCallback(() => {
      if (!hasIncrementedView && videoRef.current && videoRef.current.currentTime > 3) {
        setHasIncrementedView(true);
        incrementVideoViews(videoId).catch(console.error);
      }
    }, [hasIncrementedView, videoId]);

    return (
      <div className={cn("video-player", className)} id="video-player-container">
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          preload="metadata"
          onCanPlay={handleCanPlay}
          onTimeUpdate={handleTimeUpdate}
          style={{ width: "100%", height: "100%", borderRadius: "inherit" }}
        />
      </div>
    );
  }
);

VideoPlayer.displayName = "VideoPlayer";

export default VideoPlayer;
