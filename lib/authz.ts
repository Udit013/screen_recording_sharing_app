// Shared video-authorization helpers.
//
// Server Actions are public HTTP endpoints: any authenticated caller can invoke
// any exported action with any argument, regardless of what this app's own UI
// would allow. Actions that touch a video therefore have to re-derive whether
// the caller may see it, rather than assuming the client only asks for videos
// it was already shown.
//
// NOTE: this module is deliberately NOT a "use server" file — those may only
// export async functions, and the predicates below are plain sync helpers.

import { db } from "@/drizzle/db";
import { videos } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

export interface VideoAccess {
  ownerId: string;
  visibility: Visibility;
  shareToken: string | null;
  shareTokenExpiry: Date | null;
}

/** Loads only the columns needed for an access decision. */
export async function loadVideoAccess(
  videoId: string
): Promise<VideoAccess | null> {
  const [row] = await db
    .select({
      ownerId: videos.userId,
      visibility: videos.visibility,
      shareToken: videos.shareToken,
      shareTokenExpiry: videos.shareTokenExpiry,
    })
    .from(videos)
    .where(eq(videos.videoId, videoId));
  return row ?? null;
}

/**
 * Mirrors the visibility rule in `getVideoById`: a video is readable through
 * the app UI when it is public, or when the caller owns it.
 */
export function canViewVideo(
  access: VideoAccess,
  userId: string | null
): boolean {
  return access.visibility === "public" || access.ownerId === userId;
}

/** True while an unexpired share link exists for this video. */
export function hasLiveShareLink(access: VideoAccess): boolean {
  return (
    !!access.shareToken &&
    !!access.shareTokenExpiry &&
    access.shareTokenExpiry.getTime() > Date.now()
  );
}

/**
 * Throws unless the video exists and is readable by `userId`.
 *
 * The same "Video not found" message is used for both "no such video" and
 * "not allowed", so the error can't be used to probe which video ids exist.
 */
export async function assertVideoReadable(
  videoId: string,
  userId: string | null
): Promise<VideoAccess> {
  const access = await loadVideoAccess(videoId);
  if (!access || !canViewVideo(access, userId)) {
    throw new Error("Video not found");
  }
  return access;
}

/**
 * Looser check used by view/watch writes only: anonymous viewers arriving
 * through a live share link legitimately generate analytics for a video they
 * cannot otherwise browse to, so an active share token also grants access.
 */
export async function assertVideoCountable(
  videoId: string,
  userId: string | null
): Promise<void> {
  const access = await loadVideoAccess(videoId);
  if (!access) throw new Error("Video not found");
  if (canViewVideo(access, userId) || hasLiveShareLink(access)) return;
  throw new Error("Video not found");
}
