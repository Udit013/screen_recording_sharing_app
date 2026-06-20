"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import {
  getUserPlaylists,
  createPlaylist,
  deletePlaylist,
} from "@/lib/actions/playlists";

const PlaylistsManager = () => {
  const [playlists, setPlaylists] = useState<PlaylistWithCount[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    getUserPlaylists()
      .then(setPlaylists)
      .finally(() => setLoaded(true));
  }, []);

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const created = await createPlaylist(trimmed, description);
      setPlaylists((prev) => [{ ...created, videoCount: 0 }, ...prev]);
      setName("");
      setDescription("");
    });
  };

  const handleDelete = (id: string) => {
    if (!confirm("Delete this playlist? Videos are not deleted.")) return;
    startTransition(async () => {
      await deletePlaylist(id);
      setPlaylists((prev) => prev.filter((p) => p.id !== id));
    });
  };

  return (
    <div className="playlists-page">
      <div className="playlist-create-card">
        <h2>Create a collection</h2>
        <input
          className="playlist-input"
          placeholder="Name (e.g. Interview Prep)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="playlist-input"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button
          className="playlist-create-btn"
          onClick={handleCreate}
          disabled={isPending || !name.trim()}
        >
          {isPending ? "Creating…" : "Create collection"}
        </button>
      </div>

      {!loaded ? (
        <p className="text-gray-100 py-4">Loading collections…</p>
      ) : playlists.length === 0 ? (
        <p className="text-gray-100 py-4">
          No collections yet. Create one above to organize your videos.
        </p>
      ) : (
        <ul className="playlist-grid">
          {playlists.map((p) => (
            <li key={p.id} className="playlist-card">
              <Link href={`/playlists/${p.id}`} className="playlist-card-link">
                <h3>{p.name}</h3>
                {p.description && <p className="playlist-desc">{p.description}</p>}
                <span className="playlist-count">
                  {p.videoCount} {p.videoCount === 1 ? "video" : "videos"}
                </span>
              </Link>
              <button
                className="playlist-delete-btn"
                onClick={() => handleDelete(p.id)}
                aria-label="Delete collection"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default PlaylistsManager;
