"use client";

// Uploads one audio file for the multitrack editor: checked and measured in
// the browser first (it must decode, and its duration comes from the audio
// itself), then sent straight to Cloudinary with a signature from the server.
// Cancellable, with byte-level progress.

import { getAudioUploadParams } from "@/lib/actions/edit";
import { MIX_LIMITS } from "./tracks";

export interface UploadedAudio { url: string; name: string; duration: number }

export async function probeAudio(file: File): Promise<number> {
  if (file.size > MIX_LIMITS.maxUploadBytes) {
    throw new Error(`"${file.name}" is ${(file.size / 1048576).toFixed(0)} MB; the limit is ${MIX_LIMITS.maxUploadBytes / 1048576} MB.`);
  }
  const ctx = new OfflineAudioContext(1, 1, 48000);
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    if (buf.duration < MIX_LIMITS.minClip) throw new Error("too short");
    if (buf.duration > MIX_LIMITS.maxAssetSeconds) throw new Error("longer than an hour");
    return buf.duration;
  } catch (err) {
    const why = err instanceof Error && /short|hour/.test(err.message) ? err.message : "this browser can't decode it";
    throw new Error(`"${file.name}" can't be used: ${why}.`);
  }
}

export async function uploadAudio(
  videoId: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal
): Promise<UploadedAudio> {
  const duration = await probeAudio(file);
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  const params = await getAudioUploadParams(videoId);
  const res = await new Promise<{ secure_url: string }>((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("api_key", params.apiKey);
    form.append("timestamp", String(params.timestamp));
    form.append("signature", params.signature);
    form.append("public_id", params.publicId);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", params.uploadUrl);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve(JSON.parse(xhr.responseText))
      : reject(new Error(`Upload failed (${xhr.status}).`)));
    xhr.onerror = () => reject(new Error("Upload failed: network error."));
    xhr.onabort = () => reject(new DOMException("Cancelled", "AbortError"));
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(form);
  });
  return { url: res.secure_url, name: file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Audio", duration };
}
