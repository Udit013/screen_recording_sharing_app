"use server";

import { db } from "@/drizzle/db";
import { comments, videos, user } from "@/drizzle/schema";
import { and, asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { requiredString, clampInt, LIMITS } from "@/lib/validate";

const getSessionUserId = async (): Promise<string> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Unauthenticated");
  return session.user.id;
};

export async function getComments(videoId: string): Promise<CommentWithUser[]> {
  const rows = await db
    .select({
      id: comments.id,
      videoId: comments.videoId,
      userId: comments.userId,
      parentId: comments.parentId,
      timestamp: comments.timestamp,
      content: comments.content,
      createdAt: comments.createdAt,
      userName: user.name,
      userImage: user.image,
    })
    .from(comments)
    .leftJoin(user, eq(user.id, comments.userId))
    .where(eq(comments.videoId, videoId))
    .orderBy(asc(comments.createdAt));
  return rows;
}

export async function addComment(
  videoId: string,
  content: string,
  timestamp: number | null,
  parentId: string | null
): Promise<CommentWithUser> {
  const userId = await getSessionUserId();
  const trimmed = requiredString(content, "Comment", LIMITS.noteContent);

  // Replies must reference a real top-level comment on the same video.
  if (parentId) {
    const [parent] = await db
      .select({ id: comments.id, parentId: comments.parentId })
      .from(comments)
      .where(and(eq(comments.id, parentId), eq(comments.videoId, videoId)));
    if (!parent) throw new Error("Parent comment not found");
    if (parent.parentId) throw new Error("Replies cannot be nested further");
  }

  const [created] = await db
    .insert(comments)
    .values({
      videoId,
      userId,
      parentId,
      timestamp:
        timestamp === null
          ? null
          : clampInt(timestamp, 0, LIMITS.maxTimestampSeconds),
      content: trimmed,
    })
    .returning();

  const [author] = await db
    .select({ name: user.name, image: user.image })
    .from(user)
    .where(eq(user.id, userId));

  return {
    ...created,
    userName: author?.name ?? null,
    userImage: author?.image ?? null,
  };
}

export async function deleteComment(commentId: string): Promise<void> {
  const userId = await getSessionUserId();

  const [target] = await db
    .select({
      id: comments.id,
      authorId: comments.userId,
      videoId: comments.videoId,
    })
    .from(comments)
    .where(eq(comments.id, commentId));
  if (!target) return;

  // The comment author or the video owner may delete.
  if (target.authorId !== userId) {
    const [video] = await db
      .select({ ownerId: videos.userId })
      .from(videos)
      .where(eq(videos.videoId, target.videoId));
    if (!video || video.ownerId !== userId) throw new Error("Not authorized");
  }

  // Remove the comment and any direct replies.
  await db
    .delete(comments)
    .where(
      and(eq(comments.videoId, target.videoId), eq(comments.parentId, commentId))
    );
  await db.delete(comments).where(eq(comments.id, commentId));
}
