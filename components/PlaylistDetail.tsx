"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { formatDuration } from "@/lib/utils";
import {
  getPlaylist,
  renamePlaylist,
  deletePlaylist,
  removeVideoFromPlaylist,
} from "@/lib/actions/playlists";

interface PlaylistDetailProps {
  playlistId: string;
}

const PlaylistDetail = ({ playlistId }: PlaylistDetailProps) => {
  const router = useRouter();
  const [data, setData] = useState<{
    playlist: Playlist;
    videos: PlaylistVideoItem[];
    isOwner: boolean;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    getPlaylist(playlistId)
      .then((res) => {
        setData(res);
        if (res) {
          setName(res.playlist.name);
          setDescription(res.playlist.description ?? "");
        }
      })
      .finally(() => setLoaded(true));
  }, [playlistId]);

  const handleRename = () => {
    if (!name.trim()) return;
    startTransition(async () => {
      await renamePlaylist(playlistId, name, description);
      setData((prev) =>
        prev
          ? {
              ...prev,
              playlist: {
                ...prev.playlist,
                name: name.trim(),
                description: description.trim() || null,
              },
            }
          : prev
      );
      setEditing(false);
    });
  };

  const handleDeletePlaylist = () => {
    if (!confirm("Delete this collection? Videos are not deleted.")) return;
    startTransition(async () => {
      await deletePlaylist(playlistId);
      router.push("/playlists");
    });
  };

  const handleRemoveVideo = (videoId: string) => {
    startTransition(async () => {
      await removeVideoFromPlaylist(playlistId, videoId);
      setData((prev) =>
        prev
          ? { ...prev, videos: prev.videos.filter((v) => v.videoId !== videoId) }
          : prev
      );
    });
  };

  if (!loaded) return <p className="text-gray-100 py-6">Loading…</p>;
  if (!data)
    return (
      <div className="py-6">
        <p className="text-gray-100">Collection not found.</p>
        <Link href="/playlists" className="text-pink-100 font-semibold">
          ← Back to collections
        </Link>
      </div>
    );

  const { playlist, videos, isOwner } = data;

  return (
    <div className="playlist-detail">
      <Link href="/playlists" className="text-pink-100 font-semibold text-sm">
        ← All collections
      </Link>

      <div className="playlist-detail-header">
        {editing ? (
          <div className="playlist-edit">
            <input
              className="playlist-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="playlist-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
            />
            <div className="playlist-edit-actions">
              <button
                className="playlist-create-btn"
                onClick={handleRename}
                disabled={isPending || !name.trim()}
              >
                Save
              </button>
              <button
                className="playlist-cancel-btn"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <h1>{playlist.name}</h1>
              {playlist.description && (
                <p className="playlist-desc">{playlist.description}</p>
              )}
              <span className="playlist-count">
                {videos.length} {videos.length === 1 ? "video" : "videos"}
              </span>
            </div>
            {isOwner && (
              <div className="playlist-detail-actions">
                <button onClick={() => setEditing(true)} className="playlist-cancel-btn">
                  Rename
                </button>
                <button
                  onClick={handleDeletePlaylist}
                  className="playlist-delete-text-btn"
                >
                  Delete
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {videos.length === 0 ? (
        <p className="text-gray-100 py-4">
          No videos in this collection yet. Open any video and use “Add to
          collection”.
        </p>
      ) : (
        <ul className="playlist-video-list">
          {videos.map((v) => (
            <li key={v.id} className="playlist-video-item">
              <Link href={`/video/${v.videoId}`} className="playlist-video-link">
                <Image
                  src={v.thumbnailUrl}
                  alt={v.title}
                  width={160}
                  height={90}
                  className="playlist-video-thumb"
                />
                <div className="playlist-video-meta">
                  <h3>{v.title}</h3>
                  {v.duration ? (
                    <span>{formatDuration(v.duration)}</span>
                  ) : null}
                </div>
              </Link>
              {isOwner && (
                <button
                  className="playlist-delete-btn"
                  onClick={() => handleRemoveVideo(v.videoId)}
                  aria-label="Remove from collection"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default PlaylistDetail;
