"use client";

import { cn, parseTranscript, parseTimeToSeconds } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import EmptyState from "./EmptyState";
import VideoChapters from "./VideoChapters";
import VideoNotes from "./VideoNotes";
import { infos } from "@/constants";

interface VideoInfoFullProps extends VideoInfoProps {
  onSeek?: (seconds: number) => void;
  getCurrentTime?: () => number;
}

// Wraps case-insensitive matches of `query` in <mark> for search highlighting.
const highlight = (text: string, query: string) => {
  if (!query.trim()) return text;
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "ig"));
  return parts.map((part, i) =>
    part.toLowerCase() === query.trim().toLowerCase() ? (
      <mark key={i}>{part}</mark>
    ) : (
      part
    )
  );
};

const VideoInfo = ({
  transcript,
  transcriptSegments,
  aiSummary,
  tags,
  chapters,
  createdAt,
  description,
  videoId,
  videoUrl,
  title,
  ownerId,
  onSeek,
  getCurrentTime,
}: VideoInfoFullProps) => {
  const [activeTab, setActiveTab] = useState("ai summary");
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [transcriptCopied, setTranscriptCopied] = useState(false);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const activeSegmentRef = useRef<HTMLLIElement | null>(null);

  // Follow playback while a time-synced tab is open so the active transcript
  // segment and chapter stay highlighted.
  const timeSyncedTab = activeTab === "transcript" || activeTab === "chapters";
  useEffect(() => {
    if (!timeSyncedTab || !getCurrentTime) return;
    const id = setInterval(() => {
      setCurrentSeconds(Math.floor(getCurrentTime()));
    }, 500);
    return () => clearInterval(id);
  }, [timeSyncedTab, getCurrentTime]);

  // Prefer structured segments captured at record time; fall back to
  // parsing a raw VTT-style transcript blob.
  const segments = useMemo<TranscriptEntry[]>(() => {
    if (transcriptSegments && transcriptSegments.length > 0)
      return transcriptSegments;
    return parseTranscript(transcript ?? "");
  }, [transcriptSegments, transcript]);

  const visibleSegments = useMemo(() => {
    const q = transcriptQuery.trim().toLowerCase();
    if (!q) return segments;
    return segments.filter((s) => s.text.toLowerCase().includes(q));
  }, [segments, transcriptQuery]);

  // Index (within visibleSegments) of the segment currently being spoken.
  const activeSegmentIndex = useMemo(() => {
    let active = -1;
    for (let i = 0; i < visibleSegments.length; i++) {
      if (parseTimeToSeconds(visibleSegments[i].time) <= currentSeconds) {
        active = i;
      } else {
        break;
      }
    }
    return active;
  }, [visibleSegments, currentSeconds]);

  // Keep the active segment in view as playback progresses (not while searching).
  useEffect(() => {
    if (activeTab !== "transcript" || transcriptQuery) return;
    activeSegmentRef.current?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [activeSegmentIndex, activeTab, transcriptQuery]);

  const copyTranscript = () => {
    const flat = segments.map((s) => `[${s.time}] ${s.text}`).join("\n");
    navigator.clipboard.writeText(flat).then(() => {
      setTranscriptCopied(true);
      setTimeout(() => setTranscriptCopied(false), 2000);
    });
  };

  const metaDatas = [
    {
      label: "Video title",
      value: `${title} — ${new Date(createdAt).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })}`,
    },
    { label: "Video description", value: description },
    { label: "Video ID", value: videoId },
    { label: "Video URL", value: videoUrl },
  ];

  const renderTranscript = () => {
    if (segments.length === 0) {
      return (
        <EmptyState
          icon="/assets/icons/copy.svg"
          title="No transcript for this video"
          description="Transcripts are captured live from your microphone while recording in the studio (Chrome/Edge). Browsers can't transcribe uploaded video files, so uploads don't include one."
        />
      );
    }

    return (
      <div className="transcript-panel">
        <div className="transcript-toolbar">
          <input
            type="search"
            className="transcript-search"
            placeholder="Search transcript…"
            value={transcriptQuery}
            onChange={(e) => setTranscriptQuery(e.target.value)}
            aria-label="Search transcript"
          />
          <button className="transcript-copy" onClick={copyTranscript}>
            {transcriptCopied ? "Copied!" : "Copy"}
          </button>
        </div>

        {visibleSegments.length === 0 ? (
          <p className="transcript-no-match">
            No matches for “{transcriptQuery}”.
          </p>
        ) : (
          <ul className="transcript">
            {visibleSegments.map((item, index) => (
              <li
                key={index}
                ref={index === activeSegmentIndex ? activeSegmentRef : null}
                className={cn({ "transcript-active": index === activeSegmentIndex })}
              >
                <button
                  className="transcript-time"
                  onClick={() => onSeek?.(parseTimeToSeconds(item.time))}
                >
                  {item.time}
                </button>
                <p>{highlight(item.text, transcriptQuery)}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  };

  const renderAiSummary = () => (
    <div className="ai-summary">
      {aiSummary ? (
        <>
          <p className="summary-text">{aiSummary}</p>
          {tags && tags.length > 0 && (
            <div className="tags-container">
              {tags.map((tag, i) => (
                <span key={i} className="tag">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <EmptyState
          icon="/assets/icons/message.svg"
          title="No AI summary yet"
          description="AI summary will be generated automatically once the video finishes processing."
        />
      )}
    </div>
  );

  const renderChapters = () => (
    <VideoChapters
      chapters={chapters}
      videoId={videoId}
      ownerId={ownerId}
      onSeek={onSeek}
      currentSeconds={currentSeconds}
    />
  );

  const renderNotes = () => (
    <VideoNotes
      videoId={videoId}
      onSeek={onSeek}
      getCurrentTime={getCurrentTime}
    />
  );

  const renderMetadata = () => (
    <div className="metadata">
      {metaDatas.map(({ label, value }, index) => (
        <article key={index}>
          <h2>{label}</h2>
          <p
            className={cn({
              "text-pink-100 truncate": label === "Video URL",
            })}
          >
            {value}
          </p>
        </article>
      ))}
    </div>
  );

  const renderContent = () => {
    switch (activeTab) {
      case "transcript": return renderTranscript();
      case "ai summary": return renderAiSummary();
      case "chapters": return renderChapters();
      case "notes": return renderNotes();
      case "metadata": return renderMetadata();
      default: return null;
    }
  };

  return (
    <section className="video-info">
      <div
        role="tablist"
        aria-label="Video details"
        onKeyDown={(e) => {
          // Arrow keys move between tabs, as in the WAI-ARIA tabs pattern.
          const i = infos.indexOf(activeTab);
          let next = i;
          if (e.key === "ArrowRight") next = (i + 1) % infos.length;
          else if (e.key === "ArrowLeft") next = (i - 1 + infos.length) % infos.length;
          else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = infos.length - 1;
          else return;
          e.preventDefault();
          setActiveTab(infos[next]);
          document.getElementById(`video-tab-${infos[next].replace(/\s+/g, "-")}`)?.focus();
        }}
      >
        {infos.map((item) => (
          <button
            key={item}
            id={`video-tab-${item.replace(/\s+/g, "-")}`}
            type="button"
            role="tab"
            aria-selected={activeTab === item}
            aria-controls="video-tabpanel"
            tabIndex={activeTab === item ? 0 : -1}
            className={cn({
              "text-pink-100 border-b-2 border-pink-100": activeTab === item,
            })}
            onClick={() => setActiveTab(item)}
          >
            {item === "ai summary" ? "AI summary" : item}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="video-tabpanel"
        aria-labelledby={`video-tab-${activeTab.replace(/\s+/g, "-")}`}
        tabIndex={0}
      >
        {renderContent()}
      </div>
    </section>
  );
};

export default VideoInfo;
