"use server";
// Upload failures happen in the browser (it talks to Cloudinary directly),
// so the server never sees them. The upload page reports them here so they
// show up in the deployment's logs. No file contents, names or user data
// beyond the user id; one line per event.
import { headers } from "next/headers";
import { auth } from "@/lib/auth";

export interface UploadReport {
  event: "failed" | "fallback";
  stage: string;
  message: string;
  status?: number;
  fileBytes?: number;
  fileType?: string;
  via?: "direct" | "proxy";
  chunk?: number;
  online?: boolean;
  connection?: string;
}

export async function reportUploadIssue(r: UploadReport): Promise<void> {
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });
  if (!session) return;
  const clip = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
  console.error(`[upload] ${JSON.stringify({
    event: r.event === "fallback" ? "fallback" : "failed",
    user: session.user.id,
    stage: clip(r.stage, 40),
    message: clip(r.message),
    status: r.status ?? null,
    fileMB: r.fileBytes ? Math.round((r.fileBytes / 1048576) * 10) / 10 : null,
    fileType: clip(r.fileType, 60),
    via: r.via ?? null,
    chunk: r.chunk ?? null,
    online: r.online ?? null,
    connection: clip(r.connection, 20),
    ua: clip(h.get("user-agent"), 200),
  })}`);
}
