"use server";

import { db } from "@/drizzle/db";
import { videos, user } from "@/drizzle/schema";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { auth } from "@/lib/auth";
import { doesContentMatch, getOrderByClause } from "@/lib/utils";
import { getSignedUploadParams, deleteCloudinaryResource } from "@/lib/cloudinary";
import { SHARE_TOKEN_EXPIRY_DAYS } from "@/constants";
import { analyzeVideoContent, generateChapters } from "@/lib/gemini";
import {
  requiredString,
  assertVisibility,
  clampInt,
  LIMITS,
} from "@/lib/validate";
import { assertVideoReadable } from "@/lib/authz";

// A claimed AI run older than this is assumed dead and may be reclaimed.
// Comfortably above Vercel's serverless function limit (60s max on Hobby),
// so a run that is still alive can never be reclaimed out from under itself.
const PROCESSING_STALE_MS = 2 * 60 * 1000;

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const getThumbnailUploadUrl = withError(async (videoId: string) => {
  const userId = await getSessionUserId();
  if (!UUID_RE.test(videoId)) throw new Error("Invalid video id");

  // If this videoId already belongs to a saved video, only its owner may
  // request a signed URL for it (prevents overwriting another user's assets).
  const [existing] = await db
    .select({ userId: videos.userId })
    .from(videos)
    .where(eq(videos.videoId, videoId));
  if (existing && existing.userId !== userId) throw new Error("Not authorized");

  return getSignedUploadParams("snapcast/thumbnails", videoId, "image");
});

export const saveVideoDetails = withError(async (videoDetails: VideoDetails) => {
  const userId = await getSessionUserId();

  if (!UUID_RE.test(videoDetails.videoId)) throw new Error("Invalid video id");

  // Only accept media URLs from our own Cloudinary account — these fields
  // cross the network as plain strings and must not be trusted.
  const cloudPrefix = `https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`;
  if (
    !videoDetails.videoUrl.startsWith(cloudPrefix) ||
    !videoDetails.thumbnailUrl.startsWith(cloudPrefix)
  ) {
    throw new Error("Media URLs must come from the configured CDN");
  }

  // Both assets are uploaded under a public_id derived from this videoId, so
  // both URLs must reference it. Without this, a caller could save a new row
  // pointing at an asset somebody else uploaded — re-publishing another user's
  // video under their own account.
  if (
    !videoDetails.videoUrl.includes(videoDetails.videoId) ||
    !videoDetails.thumbnailUrl.includes(videoDetails.videoId)
  ) {
    throw new Error("Media URLs do not belong to this video");
  }

  const title = requiredString(videoDetails.title, "Title", LIMITS.title);
  const description = requiredString(
    videoDetails.description,
    "Description",
    LIMITS.description
  );
  const visibility = assertVisibility(videoDetails.visibility);

  const tagsArray = (
    typeof videoDetails.tags === "string"
      ? videoDetails.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
      : (videoDetails.tags ?? [])
  )
    .slice(0, LIMITS.maxTags)
    .map((t) => t.slice(0, LIMITS.tagLength));

  const now = new Date();
  await db.insert(videos).values({
    title,
    description,
    videoId: videoDetails.videoId,
    videoUrl: videoDetails.videoUrl,
    thumbnailUrl: videoDetails.thumbnailUrl,
    visibility,
    duration:
      videoDetails.duration != null
        ? clampInt(videoDetails.duration, 0, LIMITS.maxTimestampSeconds)
        : null,
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

  // Deliberately excludes `email`: profile pages are viewable by anyone, and
  // this payload is rendered client-side, so selecting the address here would
  // publish every user's email to any visitor.
  const [userInfo] = await db
    .select({ id: user.id, name: user.name, image: user.image })
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
  const session = await auth.api.getSession({ headers: await headers() });
  const currentUserId = session?.user.id;

  // The visibility rule is folded into the UPDATE rather than run as a
  // separate SELECT, so this stays a single round trip on a hot path. A video
  // the caller may not view simply matches zero rows.
  //
  // An active share link also qualifies: anonymous viewers arriving through
  // /share/[token] are legitimate views of an otherwise unlisted video.
  await db
    .update(videos)
    // Intentionally does not touch updatedAt: a view is not an edit, and
    // bumping it on every view made the column useless as a modification time.
    .set({ views: sql`${videos.views} + 1` })
    .where(
      and(
        eq(videos.videoId, videoId),
        or(
          eq(videos.visibility, "public"),
          currentUserId ? eq(videos.userId, currentUserId) : undefined,
          and(
            isNotNull(videos.shareToken),
            gt(videos.shareTokenExpiry, new Date())
          )
        )
      )
    );
  revalidatePaths([`/video/${videoId}`]);
  return {};
});

// ─── AI Processing ─────────────────────────────────────────────────────────

export const processVideoAI = withError(async (videoId: string) => {
  // Requires a signed-in user AND that the user can actually see this video:
  // this action spends Gemini quota, so it must not be usable anonymously or
  // pointed at somebody else's private video.
  const userId = await getSessionUserId();
  await assertVideoReadable(videoId, userId);

  // Claim the run atomically. A plain read-then-write let every viewer who
  // opened a new video during processing start another full Gemini pipeline,
  // because "processing" was written but never checked. This conditional
  // UPDATE matches for exactly one caller: Postgres re-evaluates the WHERE
  // clause for a concurrent UPDATE after the first commits, so later callers
  // see "processing" and match nothing.
  //
  // A run claimed more than PROCESSING_STALE_MS ago is treated as dead (its
  // serverless invocation timed out or crashed) and may be reclaimed.
  const now = new Date();
  const staleBefore = new Date(now.getTime() - PROCESSING_STALE_MS);
  const [existing] = await db
    .update(videos)
    .set({ processingStatus: "processing", processingStartedAt: now })
    .where(
      and(
        eq(videos.videoId, videoId),
        or(
          inArray(videos.processingStatus, ["idle", "failed"]),
          and(
            eq(videos.processingStatus, "processing"),
            or(
              isNull(videos.processingStartedAt),
              lt(videos.processingStartedAt, staleBefore)
            )
          )
        )
      )
    )
    .returning();

  // Nothing claimed: already "ready", or another caller's run is in flight.
  if (!existing) return { alreadyProcessed: true };

  try {
    // Build context: prefer transcript, else fall back to title/description/tags
    const transcript = existing.transcript?.trim();
    const context = transcript
      ? transcript
      : `Title: ${existing.title}\nDescription: ${existing.description}\nTags: ${(existing.tags ?? []).join(", ")}`;

    // Chapters are generated from the timed transcript, but only when one
    // exists and the owner hasn't already added chapters by hand.
    const segments = existing.transcriptSegments ?? [];
    const hasManualChapters = (existing.chapters?.length ?? 0) > 0;
    const wantsChapters = !hasManualChapters && segments.length > 0;

    // The two Gemini calls are independent, so they run concurrently rather
    // than back to back — roughly halving total AI latency on a video that
    // gets both. Both helpers swallow their own errors and resolve to null,
    // so Promise.all cannot reject here.
    const [aiResult, aiChapters] = await Promise.all([
      analyzeVideoContent(context),
      wantsChapters
        ? generateChapters(
            segments
              .map((s) => `[${vttTimeToSeconds(s.time)}] ${s.text}`)
              .join("\n"),
            existing.duration ?? 0
          )
        : Promise.resolve(null),
    ]);

    await db
      .update(videos)
      .set({
        aiSummary: aiResult?.summary ?? existing.aiSummary ?? null,
        tags: aiResult?.tags?.length ? aiResult.tags : (existing.tags ?? []),
        chapters: aiChapters ?? existing.chapters ?? [],
        processingStatus: "ready",
        processingStartedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(videos.videoId, videoId));

    revalidatePaths([`/video/${videoId}`]);
    return { processed: true };
  } catch {
    await db
      .update(videos)
      .set({
        processingStatus: "failed",
        processingStartedAt: null,
        updatedAt: new Date(),
      })
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
      .slice(0, LIMITS.maxTranscriptSegments)
      .filter((s) => s && typeof s.text === "string" && s.text.trim())
      .map((s) => ({
        time: String(s.time).slice(0, 12),
        text: s.text.trim().slice(0, LIMITS.transcriptSegmentText),
      }));
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

  // Ownership MUST be confirmed before touching Cloudinary. The row delete
  // below is ownership-scoped, but destroying the CDN assets is not — doing it
  // first would let any signed-in user wipe another user's media by id while
  // that user's database row (and page) survived, pointing at a dead asset.
  const [owned] = await db
    .select({ videoId: videos.videoId })
    .from(videos)
    .where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));
  if (!owned) throw new Error("Video not found");

  await db
    .delete(videos)
    .where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));

  // Best-effort asset cleanup: the row is already gone, so a CDN failure here
  // leaves an orphaned file rather than a broken page. The two deletes are
  // independent, so they run concurrently.
  await Promise.all([
    deleteCloudinaryResource(`snapcast/videos/${videoId}`, "video").catch(() => {}),
    deleteCloudinaryResource(`snapcast/thumbnails/${videoId}`, "image").catch(() => {}),
  ]);

  revalidatePaths(["/", `/video/${videoId}`]);
  return {};
});

// ─── Share Tokens ───────────────────────────────────────────────────────────

export const generateShareToken = withError(
  async (videoId: string, expiresInDays: number = SHARE_TOKEN_EXPIRY_DAYS) => {
    const userId = await getSessionUserId();
    const token = crypto.randomUUID();
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + clampInt(expiresInDays, 1, 30));

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
