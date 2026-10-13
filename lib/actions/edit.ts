"use server";

// Editor persistence. Every action here is owner-only: editing changes what
// every viewer of a video sees, and the transcript feeds search and AI.

import { db } from "@/drizzle/db";
import { videos } from "@/drizzle/schema";
import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { sanitizeCuts, sanitizeWords } from "@/lib/media/sanitize";
import { groupSentences, sentencesToTranscriptEntries, type Word } from "@/lib/media/align";
import type { Cut } from "@/lib/media/edl";
import { isPauseLevel, type PauseLevel } from "@/lib/media/pauses";

/** Upper bound when the stored duration is unknown: matches LIMITS (24 h). */
const UNKNOWN_DURATION = 86_400;

async function requireOwnedVideo(videoId: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Unauthenticated");
  const [video] = await db
    .select({ videoId: videos.videoId, duration: videos.duration })
    .from(videos)
    .where(and(eq(videos.videoId, videoId), eq(videos.userId, session.user.id)));
  // Same message for "missing" and "not yours", so ids can't be probed.
  if (!video) throw new Error("Video not found");
  return { userId: session.user.id, maxDuration: video.duration ?? UNKNOWN_DURATION };
}

export interface EditorData {
  videoId: string;
  title: string;
  videoUrl: string;
  duration: number | null;
  words: Word[] | null;
  cuts: Cut[];
  pauseLevel: PauseLevel | null;
}

/** Everything the editor needs, for the owner only. */
export async function getEditorData(videoId: string): Promise<EditorData | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const [row] = await db
    .select({
      videoId: videos.videoId,
      title: videos.title,
      videoUrl: videos.videoUrl,
      duration: videos.duration,
      words: videos.words,
      edl: videos.edl,
    })
    .from(videos)
    .where(and(eq(videos.videoId, videoId), eq(videos.userId, session.user.id)));
  if (!row) return null;
  return {
    videoId: row.videoId,
    title: row.title,
    videoUrl: row.videoUrl,
    duration: row.duration,
    words: row.words ?? null,
    cuts: row.edl?.cuts ?? [],
    pauseLevel: row.edl?.pauseLevel ?? null,
  };
}

/**
 * Stores a word-level transcript produced by in-browser Whisper.
 *
 * Also rewrites the sentence-level transcript the rest of the app reads, so
 * search, the transcript tab and AI chapters all improve — including for
 * uploaded videos, which previously had no transcript at all. Resetting
 * processingStatus lets the next view regenerate the AI summary from the new
 * text; owner-authored chapters are still never overwritten (processVideoAI).
 */
export async function saveWordTranscript(
  videoId: string,
  words: unknown
): Promise<{ wordCount: number; sentenceCount: number }> {
  const { userId, maxDuration } = await requireOwnedVideo(videoId);
  const clean = sanitizeWords(words, maxDuration);
  const sentences = groupSentences(clean);

  await db
    .update(videos)
    .set({
      words: clean,
      transcript: clean.map((w) => w.text).join(" ") || null,
      transcriptSegments: sentencesToTranscriptEntries(sentences),
      processingStatus: "idle",
      processingStartedAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));

  revalidatePath(`/video/${videoId}`);
  return { wordCount: clean.length, sentenceCount: sentences.length };
}

/** Stores the edit (cut list). The source asset is never touched. */
export async function saveEdit(
  videoId: string,
  cuts: unknown,
  pauseLevel: unknown
): Promise<{ cutCount: number }> {
  const { userId, maxDuration } = await requireOwnedVideo(videoId);
  const clean = sanitizeCuts(cuts, maxDuration);
  const level = isPauseLevel(pauseLevel) ? pauseLevel : null;

  await db
    .update(videos)
    .set({ edl: { version: 1, cuts: clean, pauseLevel: level }, updatedAt: new Date() })
    .where(and(eq(videos.videoId, videoId), eq(videos.userId, userId)));

  revalidatePath(`/video/${videoId}`);
  revalidatePath(`/video/${videoId}/edit`);
  return { cutCount: clean.length };
}
