import { afterEach, describe, expect, it, vi } from "vitest";
import { planCompression, maxCompressibleSeconds, COMPRESS_TARGET_BYTES, UPLOAD_LIMIT_BYTES, AUDIO_BPS } from "@/lib/upload/plan";
import { chunkRanges, uploadToCloudinary, CHUNK_BYTES } from "@/lib/upload/cloudinaryUpload";

// Phone uploads used to fail with "network error": Cloudinary's free plan
// drops any video over 100 MB. These pin down the compression budget and the
// chunked, retrying upload that replaced the single request.

describe("compression plan", () => {
  it("fits the video plus audio under the target", () => {
    for (const seconds of [30, 90, 300, 1200]) {
      const p = planCompression(seconds, 3840, 2160)!;
      expect(((p.videoBps + p.audioBps) * seconds) / 8).toBeLessThanOrEqual(COMPRESS_TARGET_BYTES);
      expect(COMPRESS_TARGET_BYTES).toBeLessThan(UPLOAD_LIMIT_BYTES);
    }
  });

  it("scales the short side with the budget, keeps portrait orientation and even sizes, and never upscales", () => {
    expect(planCompression(60, 2160, 3840)).toMatchObject({ width: 1080, height: 1920 }); // 4K portrait phone clip
    const mid = planCompression(400, 1920, 1080)!; // ~1.6 Mbps → 540p
    expect(mid.height).toBe(540);
    expect(mid.width % 2).toBe(0);
    expect(planCompression(60, 640, 360)).toMatchObject({ width: 640, height: 360 });
  });

  it("refuses videos too long to be watchable under the limit", () => {
    const max = maxCompressibleSeconds();
    expect(planCompression(max - 5, 1920, 1080)).not.toBeNull();
    expect(planCompression(max + 60, 1920, 1080)).toBeNull();
    expect(planCompression(0, 1920, 1080)).toBeNull();
    expect(AUDIO_BPS).toBe(128_000);
  });
});

describe("chunk ranges", () => {
  it("covers every byte once with inclusive ranges", () => {
    const size = CHUNK_BYTES * 2 + 123;
    const r = chunkRanges(size);
    expect(r).toEqual([[0, CHUNK_BYTES - 1], [CHUNK_BYTES, 2 * CHUNK_BYTES - 1], [2 * CHUNK_BYTES, size - 1]]);
    expect(chunkRanges(10)).toEqual([[0, 9]]);
  });
});

// A scripted XMLHttpRequest: each send() takes the next outcome.
type Outcome = { status: number; body?: unknown } | "drop";
function fakeXhr(outcomes: Outcome[]) {
  const sent: Array<{ headers: Record<string, string>; url: string }> = [];
  class X {
    status = 0; responseText = ""; headers: Record<string, string> = {}; url = "";
    upload = { onprogress: null as null | ((e: { loaded: number }) => void) };
    onload: null | (() => void) = null; onerror: null | (() => void) = null; ontimeout: null | (() => void) = null;
    open(_m: string, u: string) { this.url = u; }
    setRequestHeader(k: string, v: string) { this.headers[k] = v; }
    send() {
      sent.push({ headers: this.headers, url: this.url });
      const o = outcomes.shift() ?? "drop";
      queueMicrotask(() => {
        if (o === "drop") return this.onerror?.();
        this.status = o.status; this.responseText = JSON.stringify(o.body ?? {});
        this.onload?.();
      });
    }
  }
  vi.stubGlobal("XMLHttpRequest", X);
  return sent;
}

const params = { uploadUrl: "https://api.cloudinary.com/v1_1/x/video/upload", publicId: "videos/a", signature: "s", timestamp: 1, apiKey: "k", cloudName: "x", resourceType: "video" };

describe("chunked upload", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it("sends Content-Range chunks under one upload id and returns the final asset", async () => {
    const sent = fakeXhr([{ status: 200, body: { done: false } }, { status: 200, body: { secure_url: "https://v.mp4", public_id: "videos/a" } }]);
    const file = new Blob([new Uint8Array(CHUNK_BYTES + 10)]);
    const r = await uploadToCloudinary(file, params, { proxyUrl: null });
    expect(r.secure_url).toBe("https://v.mp4");
    expect(sent.map((s) => s.headers["Content-Range"])).toEqual([`bytes 0-${CHUNK_BYTES - 1}/${CHUNK_BYTES + 10}`, `bytes ${CHUNK_BYTES}-${CHUNK_BYTES + 9}/${CHUNK_BYTES + 10}`]);
    expect(new Set(sent.map((s) => s.headers["X-Unique-Upload-Id"])).size).toBe(1);
  });

  it("retries a dropped chunk instead of failing the whole upload", async () => {
    vi.useFakeTimers();
    const sent = fakeXhr(["drop", { status: 503 }, { status: 200, body: { secure_url: "https://v.mp4", public_id: "videos/a" } }]);
    const p = uploadToCloudinary(new Blob([new Uint8Array(100)]), params, { proxyUrl: null });
    await vi.runAllTimersAsync();
    expect((await p).secure_url).toBe("https://v.mp4");
    expect(sent).toHaveLength(3);
  });

  it("reports the server's reason, not 'network error', and doesn't retry a rejection", async () => {
    const sent = fakeXhr([{ status: 400, body: { error: { message: "File size too large. Got 150000000. Maximum is 104857600." } } }]);
    await expect(uploadToCloudinary(new Blob([new Uint8Array(100)]), params, { proxyUrl: null })).rejects.toThrow(/File size too large/);
    expect(sent).toHaveLength(1);
  });

  it("switches to the same-origin route when Cloudinary can't be reached, and keeps the upload id", async () => {
    const sent = fakeXhr(["drop", { status: 200, body: { done: false } }, { status: 200, body: { secure_url: "https://v.mp4", public_id: "videos/a" } }]);
    const fallbacks: number[] = [];
    const r = await uploadToCloudinary(new Blob([new Uint8Array(CHUNK_BYTES + 1)]), params, { onFallback: (_r, chunk) => fallbacks.push(chunk) });
    expect(r.secure_url).toBe("https://v.mp4");
    expect(sent.map((x) => x.url)).toEqual([params.uploadUrl, "/cu/video/upload", "/cu/video/upload"]);
    expect(fallbacks).toEqual([0]);
    expect(new Set(sent.map((s) => s.headers["X-Unique-Upload-Id"])).size).toBe(1);
  });
});
