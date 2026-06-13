"use server";

import { db } from "@/drizzle/db";
import { videos, user } from "@/drizzle/schema";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { apiFetch, doesContentMatch, getEnv, getOrderByClause } from "@/lib/utils";
import { BUNNY, SHARE_TOKEN_EXPIRY_DAYS } from "@/constants";
import { analyzeTranscript } from "@/lib/gemini";
import aj, { fixedWindow, request } from "../arcjet";

const getBunny = () => ({
  libraryId: getEnv("BUNNY_LIBRARY_ID"),
  streamUrl: BUNNY.STREAM_BASE_URL,
  storageUrl: BUNNY.STORAGE_BASE_URL,
  cdnUrl: BUNNY.CDN_URL,
  streamKey: getEnv("BUNNY_STREAM_ACCESS_KEY"),
  storageKey: getEnv("BUNNY_STORAGE_ACCESS_KEY"),
});

const validateWithArcjet = async (fingerPrint: string) => {
  const rateLimit = aj.withRule(
    fixedWindow({ mode: "LIVE", window: "1m", max: 5, characteristics: ["fingerprint"] })
  );
  const req = await request();
  const decision = await rateLimit.protect(req, { fingerprint: fingerPrint });
  if (decision.isDenied()) throw new Error("Rate limit exceeded");
};

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
  const b = getBunny();
  const videoResponse = await apiFetch<BunnyVideoResponse>(
    `${b.streamUrl}/${b.libraryId}/videos`,
    { method: "POST", bunnyType: "stream", body: { title: "Temp Title", collectionId: "" } }
  );
  return {
    videoId: videoResponse.guid,
    uploadUrl: `${b.streamUrl}/${b.libraryId}/videos/${videoResponse.guid}`,
    accessKey: b.streamKey,
  };
});

export const getThumbnailUploadUrl = withError(async (videoId: string) => {
  const b = getBunny();
  const timestampedFileName = `${Date.now()}-${videoId}-thumbnail`;
  return {
    uploadUrl: `${b.storageUrl}/thumbnails/${timestampedFileName}`,
    cdnUrl: `${b.cdnUrl}/thumbnails/${timestampedFileName}`,
    accessKey: b.storageKey,
  };
});

export const saveVideoDetails = withError(async (videoDetails: VideoDetails) => {
  const userId = await getSessionUserId();
  await validateWithArcjet(userId);
  const b = getBunny();

  await apiFetch(
    `${b.streamUrl}/${b.libraryId}/videos/${videoDetails.videoId}`,
    {
      method: "POST",
      bunnyType: "stream",
      body: { title: videoDetails.title, description: videoDetails.description },
    }
  );

  const tagsArray =
    typeof videoDetails.tags === "string"
      ? videoDetails.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
      : (videoDetails.tags ?? []);

  const now = new Date();
  await db.insert(videos).values({
    title: videoDetails.title,
    description: videoDetails.description,
    videoId: videoDetails.videoId,
    thumbnailUrl: videoDetails.thumbnailUrl,
    visibility: videoDetails.visibility,
    duration: videoDetails.duration ?? null,
    tags: tagsArray,
    videoUrl: `${BUNNY.EMBED_URL}/${b.libraryId}/${videoDetails.videoId}`,
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

// ─── Processing & AI ───────────────────────────────────────────────────────

export const getVideoProcessingStatus = withError(async (videoId: string) => {
  const b = getBunny();
  const processingInfo = await apiFetch<BunnyVideoResponse>(
    `${b.streamUrl}/${b.libraryId}/videos/${videoId}`,
    { bunnyType: "stream" }
  );
  return {
    isProcessed: processingInfo.status === 4,
    encodingProgress: processingInfo.encodeProgress || 0,
    status: processingInfo.status,
  };
});

export const getTranscript = withError(async (videoId: string) => {
  if (!BUNNY.TRANSCRIPT_URL) return null;
  const response = await fetch(
    `${BUNNY.TRANSCRIPT_URL}/${videoId}/captions/en-auto.vtt`
  );
  if (!response.ok) return null;
  return response.text();
});

export const processVideoAI = withError(async (videoId: string) => {
  const [existing] = await db
    .select({ aiSummary: videos.aiSummary, transcript: videos.transcript })
    .from(videos)
    .where(eq(videos.videoId, videoId));

  if (existing?.aiSummary) return { alreadyProcessed: true };

  const transcriptVtt = await getTranscript(videoId);
  const transcriptText = transcriptVtt ? parseVttToText(transcriptVtt) : null;
  const aiResult = transcriptText ? await analyzeTranscript(transcriptText) : null;

  await db
    .update(videos)
    .set({
      transcript: transcriptText,
      aiSummary: aiResult?.summary ?? null,
      tags: aiResult?.tags ?? [],
      updatedAt: new Date(),
    })
    .where(eq(videos.videoId, videoId));

  revalidatePaths([`/video/${videoId}`]);
  return { processed: true };
});

function parseVttToText(vtt: string): string {
  return vtt
    .replace(/^WEBVTT.*$/m, "")
    .replace(/\d{2}:\d{2}:\d{2}\.\d{3}\s-->\s\d{2}:\d{2}:\d{2}\.\d{3}/g, "")
    .replace(/^\d+$/gm, "")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
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

export const deleteVideo = withError(
  async (videoId: string, thumbnailUrl: string) => {
    const userId = await getSessionUserId();
    const b = getBunny();

    await apiFetch(
      `${b.streamUrl}/${b.libraryId}/videos/${videoId}`,
      { method: "DELETE", bunnyType: "stream" }
    );

    if (thumbnailUrl.includes("thumbnails/")) {
      const thumbnailPath = thumbnailUrl.split("thumbnails/")[1];
      await apiFetch(
        `${b.storageUrl}/thumbnails/${thumbnailPath}`,
        { method: "DELETE", bunnyType: "storage", expectJson: false }
      ).catch(() => {});
    }

    await db
      .delete(videos)
      .where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));

    revalidatePaths(["/", `/video/${videoId}`]);
    return {};
  }
);

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
