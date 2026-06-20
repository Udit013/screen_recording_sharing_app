"use server";

import { db } from "@/drizzle/db";
import { videoViews, videos } from "@/drizzle/schema";
import { desc, eq, sql } from "drizzle-orm";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

/**
 * Records a single watch event. Called when a viewer leaves the page or the
 * video ends. Anonymous viewers (share links) are tracked via a localStorage
 * anonId so unique-viewer counts stay meaningful without requiring auth.
 */
export async function recordWatch(
  videoId: string,
  watchedSeconds: number,
  completed: boolean,
  anonId: string
): Promise<void> {
  const session = await auth.api.getSession({ headers: await headers() });
  const viewerId = session?.user.id ?? null;

  await db.insert(videoViews).values({
    videoId,
    viewerId,
    anonId: viewerId ? null : anonId || null,
    watchedSeconds: Math.max(0, Math.floor(watchedSeconds)),
    completed,
  });
}

/** Per-video analytics for the owner. */
export async function getVideoAnalytics(
  videoId: string
): Promise<VideoAnalytics> {
  const [row] = await db
    .select({
      totalViews: sql<number>`count(*)`,
      uniqueViewers: sql<number>`count(distinct coalesce(${videoViews.viewerId}, ${videoViews.anonId}))`,
      totalWatchSeconds: sql<number>`coalesce(sum(${videoViews.watchedSeconds}), 0)`,
      avgWatchSeconds: sql<number>`coalesce(avg(${videoViews.watchedSeconds}), 0)`,
      completedCount: sql<number>`count(*) filter (where ${videoViews.completed})`,
    })
    .from(videoViews)
    .where(eq(videoViews.videoId, videoId));

  const totalViews = Number(row?.totalViews ?? 0);
  const completedCount = Number(row?.completedCount ?? 0);

  return {
    totalViews,
    uniqueViewers: Number(row?.uniqueViewers ?? 0),
    totalWatchSeconds: Number(row?.totalWatchSeconds ?? 0),
    avgWatchSeconds: Math.round(Number(row?.avgWatchSeconds ?? 0)),
    completionRate: totalViews > 0 ? completedCount / totalViews : 0,
  };
}

/** Aggregate analytics across all of a user's videos (owner only). */
export async function getChannelAnalytics(
  userId: string
): Promise<ChannelAnalytics> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session || session.user.id !== userId) {
    return {
      totalVideos: 0,
      totalViews: 0,
      uniqueViewers: 0,
      totalWatchSeconds: 0,
      avgCompletionRate: 0,
      topVideos: [],
    };
  }

  const [agg] = await db
    .select({
      totalVideos: sql<number>`count(distinct ${videos.videoId})`,
      totalViews: sql<number>`count(${videoViews.id})`,
      uniqueViewers: sql<number>`count(distinct coalesce(${videoViews.viewerId}, ${videoViews.anonId}))`,
      totalWatchSeconds: sql<number>`coalesce(sum(${videoViews.watchedSeconds}), 0)`,
      completedCount: sql<number>`count(${videoViews.id}) filter (where ${videoViews.completed})`,
      totalEvents: sql<number>`count(${videoViews.id})`,
    })
    .from(videos)
    .leftJoin(videoViews, eq(videoViews.videoId, videos.videoId))
    .where(eq(videos.userId, userId));

  const topVideos = await db
    .select({
      videoId: videos.videoId,
      title: videos.title,
      thumbnailUrl: videos.thumbnailUrl,
      views: videos.views,
    })
    .from(videos)
    .where(eq(videos.userId, userId))
    .orderBy(desc(videos.views))
    .limit(5);

  const totalEvents = Number(agg?.totalEvents ?? 0);
  const completedCount = Number(agg?.completedCount ?? 0);

  return {
    totalVideos: Number(agg?.totalVideos ?? 0),
    totalViews: Number(agg?.totalViews ?? 0),
    uniqueViewers: Number(agg?.uniqueViewers ?? 0),
    totalWatchSeconds: Number(agg?.totalWatchSeconds ?? 0),
    avgCompletionRate: totalEvents > 0 ? completedCount / totalEvents : 0,
    topVideos,
  };
}
