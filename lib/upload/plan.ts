// Fitting a phone video under the storage provider's per-file limit.
//
// Cloudinary's free plan rejects any video over 100 MB, and it does so by
// dropping the connection, which the browser can only report as a "network
// error". Phones record far more than that (1080p ≈ 130 MB a minute, 4K ≈
// 350 MB), so a video over the limit is re-encoded on the device first, at
// the bitrate that lands it safely under the limit. Pure: unit-tested.

/** Cloudinary free plan: largest video file it accepts (media_limits.video_max_size_bytes). */
export const UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
/** What we aim for when compressing, leaving room for container overhead and VBR overshoot. */
export const COMPRESS_TARGET_BYTES = Math.floor(UPLOAD_LIMIT_BYTES * 0.88);
export const AUDIO_BPS = 128_000;
/** Below this the picture is too poor to be worth it; ask for a shorter clip instead. */
export const MIN_VIDEO_BPS = 300_000;

export interface CompressionPlan {
  videoBps: number;
  audioBps: number;
  /** Output size, even numbers, aspect ratio kept; never upscaled. */
  width: number;
  height: number;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * The bitrate and size to encode at so `seconds` of video fits the target.
 * Returns null when the video is too long to fit at a watchable quality.
 */
export function planCompression(seconds: number, width: number, height: number, targetBytes = COMPRESS_TARGET_BYTES): CompressionPlan | null {
  if (!(seconds > 0) || !(width > 0) || !(height > 0)) return null;
  const totalBps = (targetBytes * 8) / seconds;
  const videoBps = Math.floor(Math.min(8_000_000, totalBps - AUDIO_BPS));
  if (videoBps < MIN_VIDEO_BPS) return null;
  // The shorter side (portrait phones too) scales down with the bitrate budget.
  const short = videoBps >= 4_000_000 ? 1080 : videoBps >= 1_800_000 ? 720 : videoBps >= 800_000 ? 540 : 360;
  const scale = Math.min(1, short / Math.min(width, height));
  return { videoBps, audioBps: AUDIO_BPS, width: even(width * scale), height: even(height * scale) };
}

/** Longest video (seconds) that can still be compressed under the limit. */
export const maxCompressibleSeconds = (targetBytes = COMPRESS_TARGET_BYTES) => Math.floor((targetBytes * 8) / (MIN_VIDEO_BPS + AUDIO_BPS));

export const formatMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
