"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  getUserPlaylists,
  getPlaylistIdsForVideo,
  createPlaylist,
  addVideoToPlaylist,
  removeVideoFromPlaylist,
} from "@/lib/actions/playlists";

interface AddToPlaylistProps {
  videoId: string;
}

const AddToPlaylist = ({ videoId }: AddToPlaylistProps) => {
  const [open, setOpen] = useState(false);
  const [playlists, setPlaylists] = useState<PlaylistWithCount[]>([]);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [newName, setNewName] = useState("");
  const [isPending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || loaded) return;
    Promise.all([getUserPlaylists(), getPlaylistIdsForVideo(videoId)])
      .then(([pls, ids]) => {
        setPlaylists(pls);
        setMemberIds(new Set(ids));
      })
      .finally(() => setLoaded(true));
  }, [open, loaded, videoId]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const toggle = (playlistId: string) => {
    const isMember = memberIds.has(playlistId);
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (isMember) next.delete(playlistId);
      else next.add(playlistId);
      return next;
    });
    startTransition(async () => {
      if (isMember) await removeVideoFromPlaylist(playlistId, videoId);
      else await addVideoToPlaylist(playlistId, videoId);
    });
  };

  const handleCreate = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    startTransition(async () => {
      const created = await createPlaylist(trimmed);
      await addVideoToPlaylist(created.id, videoId);
      setPlaylists((prev) => [{ ...created, videoCount: 1 }, ...prev]);
      setMemberIds((prev) => new Set(prev).add(created.id));
      setNewName("");
    });
  };

  return (
    <div className="add-to-playlist" ref={ref}>
      <button
        className="add-to-playlist-trigger"
        onClick={() => setOpen((o) => !o)}
        title="Add to collection"
      >
        + Collection
      </button>

      {open && (
        <div className="add-to-playlist-menu">
          {!loaded ? (
            <p className="add-to-playlist-loading">Loading…</p>
          ) : (
            <>
              {playlists.length > 0 && (
                <ul className="add-to-playlist-list">
                  {playlists.map((p) => (
                    <li key={p.id}>
                      <label>
                        <input
                          type="checkbox"
                          checked={memberIds.has(p.id)}
                          onChange={() => toggle(p.id)}
                          disabled={isPending}
                        />
                        <span>{p.name}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <div className="add-to-playlist-create">
                <input
                  placeholder="New collection…"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                />
                <button onClick={handleCreate} disabled={isPending || !newName.trim()}>
                  Add
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default AddToPlaylist;
