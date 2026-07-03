// Lightweight runtime guards for server-action inputs. Server actions are
// public HTTP endpoints — client-side types don't survive the network
// boundary, so every mutation validates its inputs here.

export function requiredString(
  value: unknown,
  field: string,
  maxLength: number
): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} cannot be empty`);
  if (trimmed.length > maxLength)
    throw new Error(`${field} must be at most ${maxLength} characters`);
  return trimmed;
}

export function optionalString(
  value: unknown,
  field: string,
  maxLength: number
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength)
    throw new Error(`${field} must be at most ${maxLength} characters`);
  return trimmed;
}

export function clampInt(value: unknown, min: number, max: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function assertVisibility(value: unknown): Visibility {
  if (value === "public" || value === "private" || value === "link-only")
    return value;
  throw new Error("Invalid visibility value");
}

// Limits shared across actions.
export const LIMITS = {
  title: 200,
  description: 5000,
  noteContent: 2000,
  playlistName: 100,
  playlistDescription: 500,
  tagLength: 30,
  maxTags: 10,
  maxTimestampSeconds: 86_400, // 24h
  maxWatchSeconds: 21_600, // 6h per event
  maxTranscriptSegments: 2_000,
  transcriptSegmentText: 1_000,
  anonIdLength: 64,
} as const;
