"use server";

import { db } from "@/drizzle/db";
import { playlists, playlistVideos, videos } from "@/drizzle/schema";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { requiredString, optionalString, LIMITS } from "@/lib/validate";
import { assertVideoReadable } from "@/lib/authz";

const getSessionUserId = async (): Promise<string> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Unauthenticated");
  return session.user.id;
};

/** Ownership guard — throws if the playlist isn't owned by the current user. */
async function assertOwner(playlistId: string, userId: string) {
  const [pl] = await db
    .select({ userId: playlists.userId })
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  if (!pl) throw new Error("Playlist not found");
  if (pl.userId !== userId) throw new Error("Not authorized");
}

export async function getUserPlaylists(): Promise<PlaylistWithCount[]> {
  const userId = await getSessionUserId();
  const rows = await db
    .select({
      id: playlists.id,
      userId: playlists.userId,
      name: playlists.name,
      description: playlists.description,
      createdAt: playlists.createdAt,
      updatedAt: playlists.updatedAt,
      videoCount: sql<number>`count(${playlistVideos.id})`,
    })
    .from(playlists)
    .leftJoin(playlistVideos, eq(playlistVideos.playlistId, playlists.id))
    .where(eq(playlists.userId, userId))
    .groupBy(playlists.id)
    .orderBy(desc(playlists.createdAt));

  return rows.map((r) => ({ ...r, videoCount: Number(r.videoCount) }));
}

export async function getPlaylist(playlistId: string): Promise<{
  playlist: Playlist;
  videos: PlaylistVideoItem[];
  isOwner: boolean;
} | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  const [pl] = await db
    .select()
    .from(playlists)
    .where(eq(playlists.id, playlistId));
  if (!pl) return null;

  // A playlist may contain videos whose visibility has since changed, and the
  // playlist id alone is not an access grant. Filter members to what this
  // viewer may actually see, so an unlisted video's title and thumbnail are
  // never exposed through somebody else's collection.
  const viewerId = session?.user.id;
  const items = await db
    .select({
      id: playlistVideos.id,
      videoId: videos.videoId,
      title: videos.title,
      thumbnailUrl: videos.thumbnailUrl,
      duration: videos.duration,
      position: playlistVideos.position,
    })
    .from(playlistVideos)
    .innerJoin(videos, eq(videos.videoId, playlistVideos.videoId))
    .where(
      and(
        eq(playlistVideos.playlistId, playlistId),
        or(
          eq(videos.visibility, "public"),
          viewerId ? eq(videos.userId, viewerId) : undefined
        )
      )
    )
    .orderBy(playlistVideos.position, playlistVideos.addedAt);

  return {
    playlist: pl as Playlist,
    videos: items,
    isOwner: session?.user.id === pl.userId,
  };
}

export async function createPlaylist(
  name: string,
  description?: string
): Promise<Playlist> {
  const userId = await getSessionUserId();
  const trimmed = requiredString(name, "Playlist name", LIMITS.playlistName);
  const desc = optionalString(
    description,
    "Description",
    LIMITS.playlistDescription
  );

  const [created] = await db
    .insert(playlists)
    .values({ userId, name: trimmed, description: desc })
    .returning();

  revalidatePath("/playlists");
  return created as Playlist;
}

export async function renamePlaylist(
  playlistId: string,
  name: string,
  description?: string
): Promise<void> {
  const userId = await getSessionUserId();
  await assertOwner(playlistId, userId);
  const trimmed = requiredString(name, "Playlist name", LIMITS.playlistName);
  const desc = optionalString(
    description,
    "Description",
    LIMITS.playlistDescription
  );

  await db
    .update(playlists)
    .set({
      name: trimmed,
      description: desc,
      updatedAt: new Date(),
    })
    .where(eq(playlists.id, playlistId));

  revalidatePath("/playlists");
  revalidatePath(`/playlists/${playlistId}`);
}

export async function deletePlaylist(playlistId: string): Promise<void> {
  const userId = await getSessionUserId();
  await assertOwner(playlistId, userId);
  await db.delete(playlists).where(eq(playlists.id, playlistId));
  revalidatePath("/playlists");
}

export async function addVideoToPlaylist(
  playlistId: string,
  videoId: string
): Promise<void> {
  const userId = await getSessionUserId();
  await assertOwner(playlistId, userId);
  // Owning the playlist is not enough — the video being added must also be one
  // this user is allowed to see.
  await assertVideoReadable(videoId, userId);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(playlistVideos)
    .where(eq(playlistVideos.playlistId, playlistId));

  await db
    .insert(playlistVideos)
    .values({ playlistId, videoId, position: Number(count) })
    .onConflictDoNothing();

  revalidatePath(`/playlists/${playlistId}`);
}

export async function removeVideoFromPlaylist(
  playlistId: string,
  videoId: string
): Promise<void> {
  const userId = await getSessionUserId();
  await assertOwner(playlistId, userId);

  await db
    .delete(playlistVideos)
    .where(
      and(
        eq(playlistVideos.playlistId, playlistId),
        eq(playlistVideos.videoId, videoId)
      )
    );

  revalidatePath(`/playlists/${playlistId}`);
}

/** Returns the set of playlist ids that already contain the given video. */
export async function getPlaylistIdsForVideo(
  videoId: string
): Promise<string[]> {
  const userId = await getSessionUserId();
  const rows = await db
    .select({ playlistId: playlistVideos.playlistId })
    .from(playlistVideos)
    .innerJoin(playlists, eq(playlists.id, playlistVideos.playlistId))
    .where(
      and(eq(playlistVideos.videoId, videoId), eq(playlists.userId, userId))
    );
  return rows.map((r) => r.playlistId);
}
