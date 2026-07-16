"use client";

import { cn, formatDuration } from "@/lib/utils";
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
  chapters?: Chapter[] | null;
  className?: string;
  onReady?: () => void;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const CONTROLS_HIDE_MS = 2600;

const VideoPlayer = forwardRef<VideoPlayerHandle, VideoPlayerProps>(
  ({ videoUrl, videoId, chapters, className, onReady }, ref) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const maxWatchedRef = useRef(0);
    const watchSentRef = useRef(false);
    const draggingRef = useRef(false);

    const [playing, setPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [buffered, setBuffered] = useState(0);
    const [volume, setVolume] = useState(1);
    const [muted, setMuted] = useState(false);
    const [speed, setSpeed] = useState(1);
    const [showSpeedMenu, setShowSpeedMenu] = useState(false);
    const [controlsVisible, setControlsVisible] = useState(true);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [hoverTime, setHoverTime] = useState<number | null>(null);
    const [hoverX, setHoverX] = useState(0);
    const [copiedTs, setCopiedTs] = useState(false);
    const [hasIncrementedView, setHasIncrementedView] = useState(false);
    const [pipSupported, setPipSupported] = useState(false);

    useImperativeHandle(ref, () => ({
      seekTo(seconds: number) {
        const v = videoRef.current;
        if (v) {
          v.currentTime = seconds;
          v.play().catch(() => {});
        }
      },
      getCurrentTime() {
        return videoRef.current?.currentTime ?? 0;
      },
    }));

    // ── Controls auto-hide ────────────────────────────────────────────────
    const pokeControls = useCallback(() => {
      setControlsVisible(true);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => {
        const v = videoRef.current;
        if (v && !v.paused && !draggingRef.current) setControlsVisible(false);
      }, CONTROLS_HIDE_MS);
    }, []);

    useEffect(() => {
      return () => {
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      };
    }, []);

    // ── Deep links (?t=95) and PiP support detection ─────────────────────
    useEffect(() => {
      setPipSupported(
        typeof document !== "undefined" && "pictureInPictureEnabled" in document
      );
    }, []);

    const handleLoadedMetadata = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      setDuration(v.duration);
      const t = Number(
        new URLSearchParams(window.location.search).get("t") ?? NaN
      );
      if (Number.isFinite(t) && t > 0 && t < v.duration) {
        v.currentTime = t;
      }
    }, []);

    // ── Playback plumbing ─────────────────────────────────────────────────
    const togglePlay = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      if (v.paused) v.play().catch(() => {});
      else v.pause();
    }, []);

    const seekBy = useCallback((delta: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + delta));
    }, []);

    const setVolumeClamped = useCallback((value: number) => {
      const v = videoRef.current;
      if (!v) return;
      const next = Math.max(0, Math.min(1, value));
      v.volume = next;
      v.muted = next === 0;
      setVolume(next);
      setMuted(next === 0);
    }, []);

    const toggleMute = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      v.muted = !v.muted;
      setMuted(v.muted);
    }, []);

    const changeSpeed = useCallback((value: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.playbackRate = value;
      setSpeed(value);
      setShowSpeedMenu(false);
    }, []);

    const toggleFullscreen = useCallback(() => {
      const el = containerRef.current;
      if (!el) return;
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      } else {
        el.requestFullscreen().catch(() => {});
      }
    }, []);

    useEffect(() => {
      const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
      document.addEventListener("fullscreenchange", onFsChange);
      return () => document.removeEventListener("fullscreenchange", onFsChange);
    }, []);

    const togglePip = useCallback(async () => {
      const v = videoRef.current;
      if (!v) return;
      try {
        if (document.pictureInPictureElement) {
          await document.exitPictureInPicture();
        } else {
          await v.requestPictureInPicture();
        }
      } catch {
        /* PiP unavailable */
      }
    }, []);

    const copyTimestampLink = useCallback(() => {
      const t = Math.floor(videoRef.current?.currentTime ?? 0);
      const url = `${window.location.origin}${window.location.pathname}?t=${t}`;
      navigator.clipboard.writeText(url).then(() => {
        setCopiedTs(true);
        setTimeout(() => setCopiedTs(false), 2000);
      });
    }, []);

    // ── Watch analytics (view count + watch event) ────────────────────────
    const handleTimeUpdate = useCallback(() => {
      const v = videoRef.current;
      if (!v) return;
      setCurrentTime(v.currentTime);
      if (v.currentTime > maxWatchedRef.current) {
        maxWatchedRef.current = v.currentTime;
      }
      if (!hasIncrementedView && v.currentTime > 3) {
        setHasIncrementedView(true);
        incrementVideoViews(videoId).catch(console.error);
      }
    }, [hasIncrementedView, videoId]);

    const handleProgress = useCallback(() => {
      const v = videoRef.current;
      if (!v || v.buffered.length === 0) return;
      setBuffered(v.buffered.end(v.buffered.length - 1));
    }, []);

    const flushWatch = useCallback(() => {
      const v = videoRef.current;
      if (!v || watchSentRef.current) return;
      const watched = Math.floor(maxWatchedRef.current);
      if (watched < 2) return;
      watchSentRef.current = true;
      const total = isFinite(v.duration) ? v.duration : 0;
      const completed = total > 0 && watched >= total * 0.9;
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

    // ── Seek track interactions ───────────────────────────────────────────
    const timeFromPointer = useCallback(
      (clientX: number): number => {
        const track = trackRef.current;
        if (!track || !duration) return 0;
        const rect = track.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return ratio * duration;
      },
      [duration]
    );

    const handleTrackPointerDown = useCallback(
      (e: React.PointerEvent) => {
        const v = videoRef.current;
        if (!v) return;
        draggingRef.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        v.currentTime = timeFromPointer(e.clientX);

        const onMove = (ev: PointerEvent) => {
          v.currentTime = timeFromPointer(ev.clientX);
        };
        const onUp = () => {
          draggingRef.current = false;
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      },
      [timeFromPointer]
    );

    const handleTrackHover = useCallback(
      (e: React.MouseEvent) => {
        const track = trackRef.current;
        if (!track) return;
        const rect = track.getBoundingClientRect();
        setHoverX(e.clientX - rect.left);
        setHoverTime(timeFromPointer(e.clientX));
      },
      [timeFromPointer]
    );

    // ── Keyboard shortcuts ────────────────────────────────────────────────
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        // Don't hijack typing inside inputs rendered near the player.
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;

        switch (e.key) {
          case " ":
          case "k":
            e.preventDefault();
            togglePlay();
            break;
          case "ArrowLeft":
            e.preventDefault();
            seekBy(-5);
            break;
          case "ArrowRight":
            e.preventDefault();
            seekBy(5);
            break;
          case "j":
            seekBy(-10);
            break;
          case "l":
            seekBy(10);
            break;
          case "ArrowUp":
            e.preventDefault();
            setVolumeClamped(volume + 0.1);
            break;
          case "ArrowDown":
            e.preventDefault();
            setVolumeClamped(volume - 0.1);
            break;
          case "m":
            toggleMute();
            break;
          case "f":
            toggleFullscreen();
            break;
          case "<":
            changeSpeed(SPEEDS[Math.max(0, SPEEDS.indexOf(speed) - 1)]);
            break;
          case ">":
            changeSpeed(
              SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)]
            );
            break;
          default:
            if (/^[0-9]$/.test(e.key) && duration > 0) {
              const v = videoRef.current;
              if (v) v.currentTime = (Number(e.key) / 10) * duration;
            }
        }
        pokeControls();
      },
      [
        togglePlay,
        seekBy,
        setVolumeClamped,
        toggleMute,
        toggleFullscreen,
        changeSpeed,
        volume,
        speed,
        duration,
        pokeControls,
      ]
    );

    const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0;
    const bufferedPct = duration > 0 ? (buffered / duration) * 100 : 0;
    const validChapters = (chapters ?? []).filter(
      (c) => duration > 0 && c.timestamp >= 0 && c.timestamp < duration
    );

    return (
      <div
        ref={containerRef}
        className={cn(
          "video-player custom-player",
          { "controls-hidden": !controlsVisible && playing },
          className
        )}
        id="video-player-container"
        tabIndex={0}
        role="region"
        aria-label="Video player"
        onKeyDown={handleKeyDown}
        onMouseMove={pokeControls}
        onMouseLeave={() => {
          if (playing && !draggingRef.current) setControlsVisible(false);
        }}
      >
        <video
          ref={videoRef}
          src={videoUrl}
          preload="metadata"
          playsInline
          onClick={togglePlay}
          onDoubleClick={toggleFullscreen}
          onLoadedMetadata={handleLoadedMetadata}
          onCanPlay={() => onReady?.()}
          onTimeUpdate={handleTimeUpdate}
          onProgress={handleProgress}
          onPlay={() => {
            setPlaying(true);
            pokeControls();
          }}
          onPause={() => {
            setPlaying(false);
            setControlsVisible(true);
          }}
          onEnded={() => {
            setPlaying(false);
            setControlsVisible(true);
            flushWatch();
          }}
        />

        {!playing && (
          <button
            className="player-big-play"
            onClick={togglePlay}
            aria-label="Play"
          >
            <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        )}

        <div className="player-controls" aria-hidden={!controlsVisible && playing}>
          {/* Seek track */}
          <div
            ref={trackRef}
            className="player-track"
            onPointerDown={handleTrackPointerDown}
            onMouseMove={handleTrackHover}
            onMouseLeave={() => setHoverTime(null)}
            role="slider"
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.floor(duration)}
            aria-valuenow={Math.floor(currentTime)}
            aria-valuetext={formatDuration(Math.floor(currentTime)) || "0:00"}
          >
            <div className="player-track-buffered" style={{ width: `${bufferedPct}%` }} />
            <div className="player-track-progress" style={{ width: `${progressPct}%` }} />
            {validChapters.map((c, i) => (
              <div
                key={i}
                className="player-chapter-tick"
                style={{ left: `${(c.timestamp / duration) * 100}%` }}
                title={c.title}
              />
            ))}
            <div className="player-track-thumb" style={{ left: `${progressPct}%` }} />
            {hoverTime !== null && (
              <div className="player-hover-time" style={{ left: hoverX }}>
                {formatDuration(Math.floor(hoverTime)) || "0:00"}
              </div>
            )}
          </div>

          <div className="player-buttons">
            <div className="player-buttons-left">
              <button onClick={togglePlay} aria-label={playing ? "Pause" : "Play"}>
                {playing ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M6 4h4v16H6zM14 4h4v16h-4z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              <button onClick={toggleMute} aria-label={muted ? "Unmute" : "Mute"}>
                {muted || volume === 0 ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.4 2.4c.06-.2.1-.4.1-.6zM3 4.3 4.3 3 21 19.7 19.7 21l-2.6-2.6A8.9 8.9 0 0 1 14 19.7v-2.1c.9-.3 1.7-.7 2.4-1.3L12 12v7l-5-5H3V9h3.3z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M3 9v6h4l5 5V4L7 9zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z" />
                  </svg>
                )}
              </button>

              <input
                className="player-volume"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={(e) => setVolumeClamped(Number(e.target.value))}
                aria-label="Volume"
              />

              <span className="player-time">
                {formatDuration(Math.floor(currentTime)) || "0:00"}
                <span className="player-time-sep"> / </span>
                {formatDuration(Math.floor(duration)) || "0:00"}
              </span>
            </div>

            <div className="player-buttons-right">
              <button
                onClick={copyTimestampLink}
                aria-label="Copy link at current time"
                title="Copy link at current time"
                className="player-ts-btn"
              >
                {copiedTs ? "Copied!" : `@${formatDuration(Math.floor(currentTime)) || "0:00"}`}
              </button>

              <div className="player-speed">
                <button
                  onClick={() => setShowSpeedMenu((s) => !s)}
                  aria-label="Playback speed"
                  aria-expanded={showSpeedMenu}
                >
                  {speed}×
                </button>
                {showSpeedMenu && (
                  <div className="player-speed-menu" role="menu">
                    {SPEEDS.map((s) => (
                      <button
                        key={s}
                        role="menuitem"
                        className={cn({ active: s === speed })}
                        onClick={() => changeSpeed(s)}
                      >
                        {s}×
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {pipSupported && (
                <button onClick={togglePip} aria-label="Picture in picture" title="Picture in picture">
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M19 7h-8v6h8V7zm4-4H1v18h22V3zm-2 16H3V5h18v14z" />
                  </svg>
                </button>
              )}

              <button
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              >
                {isFullscreen ? (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

VideoPlayer.displayName = "VideoPlayer";

export default VideoPlayer;
