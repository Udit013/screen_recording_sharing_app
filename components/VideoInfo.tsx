"use client";

import { cn, parseTranscript } from "@/lib/utils";
import { useState } from "react";
import EmptyState from "./EmptyState";
import VideoChapters from "./VideoChapters";
import VideoNotes from "./VideoNotes";
import { infos } from "@/constants";

interface VideoInfoFullProps extends VideoInfoProps {
  onSeek?: (seconds: number) => void;
  getCurrentTime?: () => number;
}

const VideoInfo = ({
  transcript,
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
  const parsedTranscript = parseTranscript(transcript ?? "");

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

  const renderTranscript = () => (
    <ul className="transcript">
      {parsedTranscript.length > 0 ? (
        parsedTranscript.map((item, index) => (
          <li key={index}>
            <h2>[{item.time}]</h2>
            <p>{item.text}</p>
          </li>
        ))
      ) : (
        <EmptyState
          icon="/assets/icons/copy.svg"
          title="No transcript available"
          description="This video doesn't include any transcribed content yet."
        />
      )}
    </ul>
  );

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
      <nav>
        {infos.map((item) => (
          <button
            key={item}
            className={cn({
              "text-pink-100 border-b-2 border-pink-100": activeTab === item,
            })}
            onClick={() => setActiveTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      {renderContent()}
    </section>
  );
};

export default VideoInfo;
