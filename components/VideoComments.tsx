"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { authClient } from "@/lib/auth-client";
import { daysAgo, formatDuration } from "@/lib/utils";
import { getComments, addComment, deleteComment } from "@/lib/actions/comments";
import ImageWithFallback from "./ImageWithFallback";

interface VideoCommentsProps {
  videoId: string;
  ownerId: string;
  onSeek?: (seconds: number) => void;
  getCurrentTime?: () => number;
}

const VideoComments = ({
  videoId,
  ownerId,
  onSeek,
  getCurrentTime,
}: VideoCommentsProps) => {
  const { data: session } = authClient.useSession();
  const [comments, setComments] = useState<CommentWithUser[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState("");
  const [atTimestamp, setAtTimestamp] = useState(true);
  // Captured when the composer gains focus, so the label shows the moment
  // the viewer intended to comment on rather than a stale render-time value.
  const [capturedTs, setCapturedTs] = useState<number | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    getComments(videoId)
      .then(setComments)
      .finally(() => setLoaded(true));
  }, [videoId]);

  const { topLevel, repliesByParent } = useMemo(() => {
    const top: CommentWithUser[] = [];
    const map = new Map<string, CommentWithUser[]>();
    for (const c of comments) {
      if (c.parentId) {
        const list = map.get(c.parentId) ?? [];
        list.push(c);
        map.set(c.parentId, list);
      } else {
        top.push(c);
      }
    }
    return { topLevel: top, repliesByParent: map };
  }, [comments]);

  const handlePost = () => {
    const text = draft.trim();
    if (!text) return;
    const ts = atTimestamp
      ? capturedTs ?? Math.floor(getCurrentTime?.() ?? 0)
      : null;
    startTransition(async () => {
      const created = await addComment(videoId, text, ts, null);
      setComments((prev) => [...prev, created]);
      setDraft("");
      setCapturedTs(null);
    });
  };

  const handleReply = (parentId: string) => {
    const text = replyDraft.trim();
    if (!text) return;
    startTransition(async () => {
      const created = await addComment(videoId, text, null, parentId);
      setComments((prev) => [...prev, created]);
      setReplyDraft("");
      setReplyTo(null);
    });
  };

  const handleDelete = (commentId: string) => {
    startTransition(async () => {
      await deleteComment(commentId);
      setComments((prev) =>
        prev.filter((c) => c.id !== commentId && c.parentId !== commentId)
      );
    });
  };

  const canDelete = (c: CommentWithUser) =>
    session?.user.id === c.userId || session?.user.id === ownerId;

  const renderComment = (c: CommentWithUser, isReply = false) => (
    <li key={c.id} className={isReply ? "comment reply" : "comment"}>
      <ImageWithFallback
        src={c.userImage ?? ""}
        alt={c.userName ?? "User"}
        width={32}
        height={32}
        className="rounded-full aspect-square comment-avatar"
      />
      <div className="comment-body">
        <div className="comment-meta">
          <span className="comment-author">{c.userName ?? "User"}</span>
          <span className="comment-date">{daysAgo(c.createdAt)}</span>
          {c.timestamp !== null && (
            <button
              className="comment-timestamp"
              onClick={() => onSeek?.(c.timestamp!)}
            >
              {formatDuration(c.timestamp) || "0:00"}
            </button>
          )}
        </div>
        <p className="comment-content">{c.content}</p>
        <div className="comment-actions">
          {session && !isReply && (
            <button
              onClick={() => {
                setReplyTo(replyTo === c.id ? null : c.id);
                setReplyDraft("");
              }}
            >
              Reply
            </button>
          )}
          {canDelete(c) && (
            <button onClick={() => handleDelete(c.id)} disabled={isPending}>
              Delete
            </button>
          )}
        </div>

        {replyTo === c.id && (
          <div className="comment-reply-form">
            <textarea
              className="comment-input"
              placeholder="Write a reply…"
              value={replyDraft}
              onChange={(e) => setReplyDraft(e.target.value)}
              rows={2}
            />
            <button
              className="comment-post-btn"
              onClick={() => handleReply(c.id)}
              disabled={isPending || !replyDraft.trim()}
            >
              Reply
            </button>
          </div>
        )}

        {(repliesByParent.get(c.id) ?? []).length > 0 && (
          <ul className="comment-replies">
            {repliesByParent.get(c.id)!.map((r) => renderComment(r, true))}
          </ul>
        )}
      </div>
    </li>
  );

  return (
    <section className="comments-section" aria-label="Comments">
      <h2 className="comments-title">
        Comments{loaded ? ` (${comments.length})` : ""}
      </h2>

      {session ? (
        <div className="comment-composer">
          <textarea
            className="comment-input"
            placeholder="Add a comment…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => {
              if (capturedTs === null) {
                setCapturedTs(Math.floor(getCurrentTime?.() ?? 0));
              }
            }}
            rows={2}
          />
          <div className="comment-composer-row">
            <label className="comment-ts-toggle">
              <input
                type="checkbox"
                checked={atTimestamp}
                onChange={(e) => setAtTimestamp(e.target.checked)}
              />
              <span>
                {capturedTs !== null
                  ? `at ${formatDuration(capturedTs) || "0:00"}`
                  : "at current time"}
              </span>
            </label>
            <button
              className="comment-post-btn"
              onClick={handlePost}
              disabled={isPending || !draft.trim()}
            >
              {isPending ? "Posting…" : "Comment"}
            </button>
          </div>
        </div>
      ) : (
        <p className="comments-signin-hint">Sign in to join the discussion.</p>
      )}

      {!loaded ? (
        <p className="comments-loading">Loading comments…</p>
      ) : topLevel.length === 0 ? (
        <p className="comments-empty">No comments yet — start the discussion.</p>
      ) : (
        <ul className="comments-list">{topLevel.map((c) => renderComment(c))}</ul>
      )}
    </section>
  );
};

export default VideoComments;
