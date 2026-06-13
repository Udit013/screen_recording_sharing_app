"use client";

import { useState, useTransition } from "react";
import { saveChapters } from "@/lib/actions/video";
import { formatDuration } from "@/lib/utils";
import { authClient } from "@/lib/auth-client";

interface VideoChaptersProps {
  chapters: Chapter[] | null | undefined;
  videoId: string;
  ownerId: string;
  onSeek?: (seconds: number) => void;
}

const VideoChapters = ({ chapters, videoId, ownerId, onSeek }: VideoChaptersProps) => {
  const { data: session } = authClient.useSession();
  const isOwner = session?.user.id === ownerId;

  const [localChapters, setLocalChapters] = useState<Chapter[]>(chapters ?? []);
  const [newTitle, setNewTitle] = useState("");
  const [newTimestamp, setNewTimestamp] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [isPending, startTransition] = useTransition();

  const addChapter = () => {
    const seconds = parseTimestamp(newTimestamp);
    if (!newTitle.trim() || seconds === null) return;

    const updated = [...localChapters, { title: newTitle.trim(), timestamp: seconds }]
      .sort((a, b) => a.timestamp - b.timestamp);

    setLocalChapters(updated);
    setNewTitle("");
    setNewTimestamp("");
    setIsAdding(false);

    startTransition(async () => {
      await saveChapters(videoId, updated);
    });
  };

  const removeChapter = (index: number) => {
    const updated = localChapters.filter((_, i) => i !== index);
    setLocalChapters(updated);
    startTransition(async () => {
      await saveChapters(videoId, updated);
    });
  };

  if (localChapters.length === 0 && !isOwner) {
    return (
      <p className="text-sm text-gray-100 py-4">No chapters added yet.</p>
    );
  }

  return (
    <div className="chapters-container">
      {localChapters.length > 0 ? (
        <ul className="chapters-list">
          {localChapters.map((chapter, i) => (
            <li key={i} className="chapter-item">
              <button
                className="chapter-seek-btn"
                onClick={() => onSeek?.(chapter.timestamp)}
              >
                <span className="chapter-time">{formatDuration(chapter.timestamp)}</span>
                <span className="chapter-title">{chapter.title}</span>
              </button>
              {isOwner && (
                <button
                  className="chapter-remove-btn"
                  onClick={() => removeChapter(i)}
                  aria-label="Remove chapter"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-100 py-2">No chapters yet. Add one below.</p>
      )}

      {isOwner && (
        <div className="chapter-add-section">
          {!isAdding ? (
            <button className="chapter-add-trigger" onClick={() => setIsAdding(true)}>
              + Add chapter
            </button>
          ) : (
            <div className="chapter-form">
              <input
                type="text"
                placeholder="Chapter title"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                className="chapter-input"
              />
              <input
                type="text"
                placeholder="Timestamp (e.g. 1:30 or 90)"
                value={newTimestamp}
                onChange={(e) => setNewTimestamp(e.target.value)}
                className="chapter-input"
              />
              <div className="chapter-form-actions">
                <button
                  onClick={addChapter}
                  disabled={isPending || !newTitle.trim() || !newTimestamp.trim()}
                  className="chapter-save-btn"
                >
                  {isPending ? "Saving…" : "Save"}
                </button>
                <button onClick={() => setIsAdding(false)} className="chapter-cancel-btn">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function parseTimestamp(input: string): number | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const parts = trimmed.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

export default VideoChapters;
