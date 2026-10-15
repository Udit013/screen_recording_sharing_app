"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { mergeRanges, summarizeEdit } from "@/lib/media/edl";
import type { StoredEdl } from "@/drizzle/schema";
import { formatDuration } from "@/lib/utils";
import { prewarmAnalysisAudio } from "@/lib/media/audio";

interface EditNudgeProps {
  videoId: string;
  videoUrl: string;
  ownerId: string;
  edl: StoredEdl | null;
  duration: number | null;
}

const dismissKey = (id: string) => `snapcast:edit-nudge-dismissed:${id}`;

/**
 * Owner-only strip above the player. Unedited videos get an invitation to the
 * editor (dismissible per video); edited ones show what the edit removed and a
 * way back in. Viewers never see it.
 */
export default function EditNudge({ videoId, videoUrl, ownerId, edl, duration }: EditNudgeProps) {
  const { data: session } = authClient.useSession();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(dismissKey(videoId)) === "1");
    } catch {
      setDismissed(false);
    }
  }, [videoId]);

  if (session?.user.id !== ownerId) return null;

  // Start fetching the editor's audio on intent, so it's cached on arrival.
  const warm = { onPointerEnter: () => prewarmAnalysisAudio(videoUrl), onFocus: () => prewarmAnalysisAudio(videoUrl) };

  const cuts = edl?.cuts ?? [];
  if (cuts.length > 0) {
    const total = duration ?? Math.max(...cuts.map((c) => c.end));
    const s = summarizeEdit(mergeRanges(cuts, total), total);
    return (
      <div className="edit-nudge is-edited">
        <span className="edit-nudge-icon" aria-hidden>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" /></svg>
        </span>
        <p className="edit-nudge-text">
          <strong>Viewers see your edited cut</strong>
          <span>
            {s.removedSeconds >= 1 ? `${Math.round(s.removedSeconds)} s removed` : "Less than a second removed"}
            {duration ? ` · plays as ${formatDuration(Math.round(s.editedDuration)) || "0:00"}` : ""} · the original
            upload is untouched
          </span>
        </p>
        <div className="edit-nudge-actions">
          <Link href={`/video/${videoId}/edit`} className="ed-btn" {...warm}>Edit again</Link>
        </div>
      </div>
    );
  }

  if (dismissed) return null;
  return (
    <div className="edit-nudge">
      <span className="edit-nudge-icon" aria-hidden>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" /></svg>
      </span>
      <p className="edit-nudge-text">
        <strong>Tighten this recording</strong>
        <span>Remove long pauses and flubbed sentences in a minute. Viewers get the clean cut; your original stays untouched.</span>
      </p>
      <div className="edit-nudge-actions">
        <button
          className="edit-nudge-dismiss"
          onClick={() => {
            setDismissed(true);
            try { localStorage.setItem(dismissKey(videoId), "1"); } catch { /* private mode */ }
          }}
        >
          Not now
        </button>
        <Link href={`/video/${videoId}/edit`} className="ed-btn is-primary" {...warm}>Open editor</Link>
      </div>
    </div>
  );
}
