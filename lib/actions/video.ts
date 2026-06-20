"use server";

import { db } from "@/drizzle/db";
import { videos, user } from "@/drizzle/schema";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { doesContentMatch, getOrderByClause } from "@/lib/utils";
import { getSignedUploadParams, deleteCloudinaryResource } from "@/lib/cloudinary";
import { SHARE_TOKEN_EXPIRY_DAYS } from "@/constants";
import { analyzeVideoContent, generateChapters } from "@/lib/gemini";

const revalidatePaths = (paths: string[]) =>
  paths.forEach((path) => revalidatePath(path));

const getSessionUserId = async (): Promise<string> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Unauthenticated");
  return session.user.id;
};

const buildVideoWithUserQuery = () =>
  db
    .select({
      video: videos,
      user: { id: user.id, name: user.name, image: user.image },
    })
    .from(videos)
    .leftJoin(user, eq(videos.userId, user.id));

// ─── Upload ────────────────────────────────────────────────────────────────

export const getVideoUploadUrl = withError(async () => {
  await getSessionUserId();
  const videoId = crypto.randomUUID();
  const params = getSignedUploadParams("snapcast/videos", videoId, "video");
  return { videoId, ...params };
});

export const getThumbnailUploadUrl = withError(async (videoId: string) => {
  await getSessionUserId();
  return getSignedUploadParams("snapcast/thumbnails", videoId, "image");
});

export const saveVideoDetails = withError(async (videoDetails: VideoDetails) => {
  const userId = await getSessionUserId();

  const tagsArray =
    typeof videoDetails.tags === "string"
      ? videoDetails.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
      : (videoDetails.tags ?? []);

  const now = new Date();
  await db.insert(videos).values({
    title: videoDetails.title,
    description: videoDetails.description,
    videoId: videoDetails.videoId,
    videoUrl: videoDetails.videoUrl,
    thumbnailUrl: videoDetails.thumbnailUrl,
    visibility: videoDetails.visibility,
    duration: videoDetails.duration ?? null,
    tags: tagsArray,
    userId,
    createdAt: now,
    updatedAt: now,
  });

  revalidatePaths(["/"]);
  return { videoId: videoDetails.videoId };
});

// ─── Read ──────────────────────────────────────────────────────────────────

export const getAllVideos = withError(async (
  searchQuery: string = "",
  sortFilter?: string,
  pageNumber: number = 1,
  pageSize: number = 8
) => {
  const session = await auth.api.getSession({ headers: await headers() });
  const currentUserId = session?.user.id;

  const visibilityFilter = currentUserId
    ? or(eq(videos.visibility, "public"), eq(videos.userId, currentUserId))
    : eq(videos.visibility, "public");

  const whereCondition = searchQuery.trim()
    ? and(visibilityFilter, doesContentMatch(searchQuery))
    : visibilityFilter;

  const [{ totalCount }] = await db
    .select({ totalCount: sql<number>`count(*)` })
    .from(videos)
    .where(whereCondition);

  const totalVideos = Number(totalCount || 0);
  const totalPages = Math.ceil(totalVideos / pageSize);

  const videoRecords = await buildVideoWithUserQuery()
    .where(whereCondition)
    .orderBy(sortFilter ? getOrderByClause(sortFilter) : sql`${videos.createdAt} DESC`)
    .limit(pageSize)
    .offset((pageNumber - 1) * pageSize);

  return {
    videos: videoRecords,
    pagination: { currentPage: pageNumber, totalPages, totalVideos, pageSize },
  };
});

export const getVideoById = withError(async (videoId: string) => {
  const session = await auth.api.getSession({ headers: await headers() });
  const currentUserId = session?.user.id;

  const [videoRecord] = await buildVideoWithUserQuery().where(
    and(
      eq(videos.videoId, videoId),
      or(
        eq(videos.visibility, "public"),
        currentUserId ? eq(videos.userId, currentUserId) : sql`false`
      )
    )
  );
  return videoRecord ?? null;
});

export const getVideoByShareToken = withError(async (token: string) => {
  const [videoRecord] = await buildVideoWithUserQuery().where(
    and(
      eq(videos.shareToken, token),
      gt(videos.shareTokenExpiry, new Date())
    )
  );
  return videoRecord ?? null;
});

export const getAllVideosByUser = withError(async (
  userIdParameter: string,
  searchQuery: string = "",
  sortFilter?: string
) => {
  const session = await auth.api.getSession({ headers: await headers() });
  const currentUserId = session?.user.id;
  const isOwner = userIdParameter === currentUserId;

  const [userInfo] = await db
    .select({ id: user.id, name: user.name, image: user.image, email: user.email })
    .from(user)
    .where(eq(user.id, userIdParameter));

  if (!userInfo) throw new Error("User not found");

  const conditions = [
    eq(videos.userId, userIdParameter),
    !isOwner ? eq(videos.visibility, "public") : undefined,
    searchQuery.trim() ? doesContentMatch(searchQuery) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const userVideos = await buildVideoWithUserQuery()
    .where(and(...conditions))
    .orderBy(sortFilter ? getOrderByClause(sortFilter) : desc(videos.createdAt));

  return { user: userInfo, videos: userVideos, count: userVideos.length };
});

// ─── Analytics ─────────────────────────────────────────────────────────────

export const incrementVideoViews = withError(async (videoId: string) => {
  await db
    .update(videos)
    .set({ views: sql`${videos.views} + 1`, updatedAt: new Date() })
    .where(eq(videos.videoId, videoId));
  revalidatePaths([`/video/${videoId}`]);
  return {};
});

// ─── AI Processing ─────────────────────────────────────────────────────────

export const processVideoAI = withError(async (videoId: string) => {
  const [existing] = await db
    .select()
    .from(videos)
    .where(eq(videos.videoId, videoId));

  if (!existing) return { processed: false };
  if (existing.aiSummary && existing.processingStatus === "ready") {
    return { alreadyProcessed: true };
  }

  await db
    .update(videos)
    .set({ processingStatus: "processing", updatedAt: new Date() })
    .where(eq(videos.videoId, videoId));

  try {
    // Build context: prefer transcript, else fall back to title/description/tags
    const transcript = existing.transcript?.trim();
    const context = transcript
      ? transcript
      : `Title: ${existing.title}\nDescription: ${existing.description}\nTags: ${(existing.tags ?? []).join(", ")}`;

    const aiResult = await analyzeVideoContent(context);

    // Generate AI chapters from the timed transcript when available and the
    // owner hasn't already added manual chapters.
    let aiChapters: Chapter[] | null = null;
    const segments = existing.transcriptSegments ?? [];
    const hasManualChapters = (existing.chapters?.length ?? 0) > 0;
    if (!hasManualChapters && segments.length > 0) {
      const timed = segments
        .map((s) => `[${vttTimeToSeconds(s.time)}] ${s.text}`)
        .join("\n");
      aiChapters = await generateChapters(timed, existing.duration ?? 0);
    }

    await db
      .update(videos)
      .set({
        aiSummary: aiResult?.summary ?? existing.aiSummary ?? null,
        tags: aiResult?.tags?.length ? aiResult.tags : (existing.tags ?? []),
        chapters: aiChapters ?? existing.chapters ?? [],
        processingStatus: "ready",
        updatedAt: new Date(),
      })
      .where(eq(videos.videoId, videoId));

    revalidatePaths([`/video/${videoId}`]);
    return { processed: true };
  } catch {
    await db
      .update(videos)
      .set({ processingStatus: "failed", updatedAt: new Date() })
      .where(eq(videos.videoId, videoId));
    return { processed: false };
  }
});

/**
 * Stores a timed transcript captured client-side (Web Speech API) during
 * recording. Saves both the structured segments and a flattened text blob
 * (used for keyword search and AI context).
 */
export const saveVideoTranscript = withError(
  async (videoId: string, segments: TranscriptEntry[]) => {
    const userId = await getSessionUserId();
    const clean = (segments ?? [])
      .filter((s) => s && typeof s.text === "string" && s.text.trim())
      .map((s) => ({ time: s.time, text: s.text.trim() }));
    const flatText = clean.map((s) => s.text).join(" ");

    await db
      .update(videos)
      .set({
        transcript: flatText || null,
        transcriptSegments: clean,
        updatedAt: new Date(),
      })
      .where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));
    revalidatePaths([`/video/${videoId}`]);
    return {};
  }
);

// Converts a transcript "mm:ss" / "hh:mm:ss" stamp into integer seconds.
function vttTimeToSeconds(time: string): number {
  const parts = time.split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

// ─── Visibility & Delete ────────────────────────────────────────────────────

export const updateVideoVisibility = withError(
  async (videoId: string, visibility: Visibility) => {
    const userId = await getSessionUserId();
    await db
      .update(videos)
      .set({ visibility, updatedAt: new Date() })
      .where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));
    revalidatePaths(["/", `/video/${videoId}`]);
    return {};
  }
);

export const deleteVideo = withError(async (videoId: string) => {
  const userId = await getSessionUserId();

  await deleteCloudinaryResource(`snapcast/videos/${videoId}`, "video").catch(() => {});
  await deleteCloudinaryResource(`snapcast/thumbnails/${videoId}`, "image").catch(() => {});

  await db
    .delete(videos)
    .where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));

  revalidatePaths(["/", `/video/${videoId}`]);
  return {};
});

// ─── Share Tokens ───────────────────────────────────────────────────────────

export const generateShareToken = withError(
  async (videoId: string, expiresInDays: number = SHARE_TOKEN_EXPIRY_DAYS) => {
    const userId = await getSessionUserId();
    const token = crypto.randomUUID();
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + expiresInDays);

    await db
      .update(videos)
      .set({ shareToken: token, shareTokenExpiry: expiry, updatedAt: new Date() })
      .where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));

    revalidatePaths([`/video/${videoId}`]);
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "";
    return { token, expiry, shareUrl: `${baseUrl}/share/${token}` } as ShareTokenResult;
  }
);

export const revokeShareToken = withError(async (videoId: string) => {
  const userId = await getSessionUserId();
  await db
    .update(videos)
    .set({ shareToken: null, shareTokenExpiry: null, updatedAt: new Date() })
    .where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));
  revalidatePaths([`/video/${videoId}`]);
  return {};
});

// ─── Chapters ───────────────────────────────────────────────────────────────

export const saveChapters = withError(
  async (videoId: string, chapters: Chapter[]) => {
    const userId = await getSessionUserId();
    await db
      .update(videos)
      .set({ chapters, updatedAt: new Date() })
      .where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));
    revalidatePaths([`/video/${videoId}`]);
    return {};
  }
);

// ─── Error wrapper ──────────────────────────────────────────────────────────

function withError<T, A extends unknown[]>(fn: (...args: A) => Promise<T>) {
  return async (...args: A): Promise<T> => fn(...args);
}
