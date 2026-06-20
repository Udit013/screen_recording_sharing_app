"use client";

import { cn } from "@/lib/utils";
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";
import { incrementVideoViews } from "@/lib/actions/video";
import { recordWatch } from "@/lib/actions/analytics";
import { getAnonId } from "@/lib/anon";

export interface VideoPlayerHandle {
  seekTo: (seconds: number) => void;
  getCurrentTime: () => number;
}

interface VideoPlayerProps {
  videoUrl: string;
  videoId: string;
  className?: string;
  onReady?: () => void;
}

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ videoUrl, videoId, className, onReady }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [hasIncrementedView, setHasIncrementedView] = useState(false);
    const maxWatchedRef = useRef(0);
    const watchSentRef = useRef(false);

    useImperativeHandle(ref, () => ({
      seekTo(seconds: number) {
        if (videoRef.current) {
          videoRef.current.currentTime = seconds;
          videoRef.current.play().catch(() => {});
        }
      },
      getCurrentTime() {
        return videoRef.current?.currentTime ?? 0;
      },
    }));

    const handleCanPlay = useCallback(() => {
      onReady?.();
    }, [onReady]);

    const handleTimeUpdate = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      if (v.currentTime > maxWatchedRef.current) {
        maxWatchedRef.current = v.currentTime;
      }
      if (!hasIncrementedView && v.currentTime > 3) {
        setHasIncrementedView(true);
        incrementVideoViews(videoId).catch(console.error);
      }
    }, [hasIncrementedView, videoId]);

    // Fire a single detailed watch event when the user leaves or the video ends.
    const flushWatch = useCallback(() => {
      const v = videoRef.current;
      if (!v || watchSentRef.current) return;
      const watched = Math.floor(maxWatchedRef.current);
      if (watched < 2) return; // ignore incidental loads
      watchSentRef.current = true;
      const duration = isFinite(v.duration) ? v.duration : 0;
      const completed = duration > 0 && watched >= duration * 0.9;
      recordWatch(videoId, watched, completed, getAnonId()).catch(() => {});
    }, [videoId]);

    useEffect(() => {
      const onHide = () => flushWatch();
      window.addEventListener("pagehide", onHide);
      return () => {
        window.removeEventListener("pagehide", onHide);
        flushWatch();
      };
    }, [flushWatch]);

    return (
      <div className={cn("video-player", className)} id="video-player-container">
        <video
          ref={videoRef}
          src={videoUrl}
          controls
          preload="metadata"
          onCanPlay={handleCanPlay}
          onTimeUpdate={handleTimeUpdate}
          onEnded={flushWatch}
        />
      </div>
    );
  }
);

VideoPlayer.displayName = "VideoPlayer";

export default VideoPlayer;
