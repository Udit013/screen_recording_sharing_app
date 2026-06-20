"use client";

import { useEffect, useState, useTransition } from "react";
import { authClient } from "@/lib/auth-client";
import { formatDuration } from "@/lib/utils";
import {
  getNotes,
  createNote,
  updateNote,
  deleteNote,
} from "@/lib/actions/notes";

interface VideoNotesProps {
  videoId: string;
  onSeek?: (seconds: number) => void;
  getCurrentTime?: () => number;
}

const VideoNotes = ({ videoId, onSeek, getCurrentTime }: VideoNotesProps) => {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const [notes, setNotes] = useState<Note[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [content, setContent] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!session) {
      setLoaded(true);
      return;
    }
    getNotes(videoId)
      .then((rows) => setNotes(rows))
      .finally(() => setLoaded(true));
  }, [videoId, session]);

  const handleAdd = () => {
    const text = content.trim();
    if (!text) return;
    const ts = Math.floor(getCurrentTime?.() ?? 0);
    startTransition(async () => {
      const created = await createNote(videoId, ts, text);
      setNotes((prev) =>
        [...prev, created].sort((a, b) => a.timestamp - b.timestamp)
      );
      setContent("");
    });
  };

  const handleSaveEdit = (id: string) => {
    const text = editText.trim();
    if (!text) return;
    startTransition(async () => {
      await updateNote(id, text);
      setNotes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, content: text } : n))
      );
      setEditingId(null);
      setEditText("");
    });
  };

  const handleDelete = (id: string) => {
    startTransition(async () => {
      await deleteNote(id);
      setNotes((prev) => prev.filter((n) => n.id !== id));
    });
  };

  if (!sessionPending && !session) {
    return (
      <p className="text-sm text-gray-100 py-4">
        Sign in to take timestamped notes on this video.
      </p>
    );
  }

  return (
    <div className="notes-container">
      <div className="note-add">
        <textarea
          className="note-input"
          placeholder="Add a note at the current timestamp…"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={2}
        />
        <button
          className="note-add-btn"
          onClick={handleAdd}
          disabled={isPending || !content.trim()}
        >
          Add note @ {formatDuration(Math.floor(getCurrentTime?.() ?? 0)) || "0:00"}
        </button>
      </div>

      {!loaded ? (
        <p className="text-sm text-gray-100 py-2">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="text-sm text-gray-100 py-2">No notes yet.</p>
      ) : (
        <ul className="notes-list">
          {notes.map((note) => (
            <li key={note.id} className="note-item">
              <button
                className="note-time"
                onClick={() => onSeek?.(note.timestamp)}
              >
                {formatDuration(note.timestamp) || "0:00"}
              </button>
              {editingId === note.id ? (
                <div className="note-edit">
                  <textarea
                    className="note-input"
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    rows={2}
                  />
                  <div className="note-edit-actions">
                    <button
                      className="note-save-btn"
                      onClick={() => handleSaveEdit(note.id)}
                      disabled={isPending}
                    >
                      Save
                    </button>
                    <button
                      className="note-cancel-btn"
                      onClick={() => setEditingId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <p className="note-content">{note.content}</p>
                  <div className="note-actions">
                    <button
                      onClick={() => {
                        setEditingId(note.id);
                        setEditText(note.content);
                      }}
                      aria-label="Edit note"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => handleDelete(note.id)}
                      aria-label="Delete note"
                    >
                      ×
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default VideoNotes;
