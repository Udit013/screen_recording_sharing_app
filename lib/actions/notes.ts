"use server";

import { db } from "@/drizzle/db";
import { notes } from "@/drizzle/schema";
import { and, asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";

const getSessionUserId = async (): Promise<string> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Unauthenticated");
  return session.user.id;
};

export async function getNotes(videoId: string): Promise<Note[]> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return [];
  const rows = await db
    .select()
    .from(notes)
    .where(and(eq(notes.videoId, videoId), eq(notes.userId, session.user.id)))
    .orderBy(asc(notes.timestamp));
  return rows as Note[];
}

export async function createNote(
  videoId: string,
  timestamp: number,
  content: string
): Promise<Note> {
  const userId = await getSessionUserId();
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Note content cannot be empty");

  const [created] = await db
    .insert(notes)
    .values({
      userId,
      videoId,
      timestamp: Math.max(0, Math.floor(timestamp)),
      content: trimmed,
    })
    .returning();

  revalidatePath(`/video/${videoId}`);
  return created as Note;
}

export async function updateNote(
  noteId: string,
  content: string
): Promise<void> {
  const userId = await getSessionUserId();
  const trimmed = content.trim();
  if (!trimmed) throw new Error("Note content cannot be empty");

  await db
    .update(notes)
    .set({ content: trimmed, updatedAt: new Date() })
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)));
}

export async function deleteNote(noteId: string): Promise<void> {
  const userId = await getSessionUserId();
  await db
    .delete(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)));
}
