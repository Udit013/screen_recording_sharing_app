// Browser → Cloudinary upload in chunks.
//
// One long request is fragile on a phone: a network switch or a locked
// screen kills it and all progress with it. Cloudinary's chunked upload
// (same signed params on every chunk, X-Unique-Upload-Id + Content-Range)
// sends 20 MB at a time, and each chunk is retried with back-off, so a hiccup
// costs one chunk, not the whole upload. Failures come back as readable
// messages instead of "network error".
//
// If the phone can't reach api.cloudinary.com at all (a carrier block or a
// filtering network: the request fails without any response), the upload
// switches to the same endpoint through this app's own domain (/cu/…, a
// rewrite in next.config.ts), which the phone evidently can reach.

export interface CloudinaryUploadParams {
  uploadUrl: string;
  publicId: string;
  signature: string;
  timestamp: number;
  apiKey: string;
  cloudName: string;
  resourceType: string;
}

export interface CloudinaryUploadResult {
  secure_url: string;
  public_id: string;
  duration?: number;
}

export const CHUNK_BYTES = 20 * 1024 * 1024; // Cloudinary: every chunk but the last must be ≥ 5 MB
const RETRIES = 4;

/** Byte ranges of each chunk, inclusive, as Content-Range wants them. */
export function chunkRanges(size: number, chunk = CHUNK_BYTES): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let start = 0; start < size; start += chunk) out.push([start, Math.min(size, start + chunk) - 1]);
  if (out.length === 0) out.push([0, -1]);
  return out;
}

class HttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Why an upload stopped, with what the failure report needs. */
export class UploadError extends Error {
  constructor(message: string, readonly detail: { status?: number; via: "direct" | "proxy"; chunk: number }) { super(message); }
}

export interface UploadOptions {
  onProgress?: (pct: number) => void;
  /** Called once when the direct route fails and the same-origin route takes over. */
  onFallback?: (reason: string, chunk: number) => void;
  /** Same-origin route; default `/cu/<type>/upload`. Null disables the fallback. */
  proxyUrl?: string | null;
}

const retryable = (err: unknown) => !(err instanceof HttpError) || err.status >= 500 || err.status === 408 || err.status === 429;

function sendChunk(
  url: string, blob: Blob, params: CloudinaryUploadParams, uploadId: string, range: [number, number], total: number,
  onBytes: (loaded: number) => void,
): Promise<CloudinaryUploadResult | null> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", blob.slice(range[0], range[1] + 1), "video");
    form.append("api_key", params.apiKey);
    form.append("timestamp", String(params.timestamp));
    form.append("signature", params.signature);
    form.append("public_id", params.publicId);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("X-Unique-Upload-Id", uploadId);
    xhr.setRequestHeader("Content-Range", `bytes ${range[0]}-${range[1]}/${total}`);
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      let body: Record<string, unknown> | null = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        // Intermediate chunks answer {done:false}; the last one returns the asset.
        resolve(body && typeof body.secure_url === "string" ? (body as unknown as CloudinaryUploadResult) : null);
      } else {
        const msg = (body?.error as { message?: string } | undefined)?.message;
        reject(new HttpError(msg ? `Upload rejected: ${msg}` : `Upload failed (HTTP ${xhr.status}).`, xhr.status));
      }
    };
    xhr.onerror = () => reject(new Error("The connection dropped."));
    xhr.ontimeout = () => reject(new Error("The connection timed out."));
    xhr.send(form);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function uploadToCloudinary(
  file: Blob, params: CloudinaryUploadParams, opts: UploadOptions = {},
): Promise<CloudinaryUploadResult> {
  const { onProgress, onFallback } = opts;
  const proxyUrl = opts.proxyUrl === undefined ? `/cu/${params.resourceType}/upload` : opts.proxyUrl;
  const total = file.size;
  const uploadId = `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let url = params.uploadUrl;
  let via: "direct" | "proxy" = "direct";
  let result: CloudinaryUploadResult | null = null;
  const ranges = chunkRanges(total);
  for (let i = 0; i < ranges.length; i++) {
    const range = ranges[i];
    for (let attempt = 0; ; attempt++) {
      try {
        result = await sendChunk(url, file, params, uploadId, range, total, (loaded) => {
          onProgress?.(Math.min(99, Math.round(((range[0] + loaded) / Math.max(1, total)) * 100)));
        });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // No response at all from Cloudinary: try the same-origin route before giving up.
        if (!(err instanceof HttpError) && via === "direct" && proxyUrl) {
          via = "proxy";
          url = proxyUrl;
          onFallback?.(msg, i);
          attempt = -1;
          continue;
        }
        if (attempt >= RETRIES || !retryable(err)) {
          const status = err instanceof HttpError ? err.status : undefined;
          throw new UploadError(
            err instanceof HttpError ? msg : `${msg} The upload stopped at ${Math.round((range[0] / Math.max(1, total)) * 100)}%. Check your connection and try again.`,
            { status, via, chunk: i },
          );
        }
        await wait(1000 * 2 ** attempt);
      }
    }
  }
  if (!result) throw new UploadError("Upload finished but the server didn't return the video. Please try again.", { via, chunk: ranges.length - 1 });
  onProgress?.(100);
  return result;
}
