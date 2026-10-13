import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getEditorData } from "@/lib/actions/edit";
import Editor from "@/components/editor/Editor";

export const metadata: Metadata = { title: "Edit video" };

type PageProps = { params: Promise<{ videoId: string }> };

// Owner-only: getEditorData returns null for anyone else, and a 404 (rather
// than 403) avoids confirming that the video exists.
export default async function EditVideoPage({ params }: PageProps) {
  const { videoId } = await params;
  const data = await getEditorData(videoId);
  if (!data) notFound();
  return <Editor data={data} />;
}
