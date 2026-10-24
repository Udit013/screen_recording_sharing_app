import { GoogleGenerativeAI } from "@google/generative-ai";

let client: GoogleGenerativeAI | null = null;

const getClient = () => {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return client;
};

/**
 * Models are tried in order. Google retires Gemini models on a schedule, and
 * gemini-2.0-flash was retired while this app still called it: every summary
 * silently failed. So the list is configurable (GEMINI_MODEL, comma-separated).
 *
 * Both defaults were benchmarked with this app's real prompt: ~3-4 s and valid
 * JSON. Deliberately NOT "gemini-flash-latest": that alias currently resolves
 * to a reasoning model that took 34 s (gemini-3.8-flash took 121 s), far past
 * what a serverless request can wait.
 */
const DEFAULT_MODELS = ["gemini-3.5-flash", "gemini-2.5-flash"];

export const geminiModels = (): string[] => {
  const configured = (process.env.GEMINI_MODEL ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_MODELS;
};

/** True when a key is set, i.e. a null result from below means "it failed". */
export const isGeminiConfigured = (): boolean => Boolean(process.env.GEMINI_API_KEY);

/** Statuses that mean "this model can't serve you", so another may. */
const TRY_NEXT_MODEL = new Set([404, 429, 500, 503]);

/**
 * Sends one prompt, falling through the model list on retirement (404),
 * quota (429) or outage (500/503). Anything else (bad key, blocked prompt)
 * stops immediately rather than spending more quota. Failures are logged
 * (never the prompt or response, which can contain a user's transcript).
 */
async function generateText(prompt: string): Promise<string | null> {
  const genAI = getClient();
  if (!genAI) return null;

  for (const name of geminiModels()) {
    try {
      const result = await genAI.getGenerativeModel({ model: name }).generateContent(prompt);
      return result.response.text().trim();
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[gemini] ${name} failed${status ? ` (HTTP ${status})` : ""}: ${message.slice(0, 200)}`);
      if (!status || !TRY_NEXT_MODEL.has(status)) return null;
    }
  }
  return null;
}

const stripFences = (text: string) =>
  text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

export interface AiVideoAnalysis {
  summary: string;
  tags: string[];
}

export async function analyzeVideoContent(
  context: string
): Promise<AiVideoAnalysis | null> {
  if (!isGeminiConfigured() || !context.trim()) return null;

  try {
    const prompt = `Analyze this video content and respond with ONLY valid JSON (no markdown, no code blocks).

Content:
${context.slice(0, 8000)}

Respond with exactly this JSON structure:
{
  "summary": "2-3 sentence summary of what this video covers",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"]
}

Rules:
- summary: concise, informative, 2-3 sentences max
- tags: 3-7 lowercase single-word or hyphenated tags describing the content
- Return ONLY the JSON object, nothing else`;

    const text = await generateText(prompt);
    if (text === null) return null;

    const parsed = JSON.parse(stripFences(text)) as AiVideoAnalysis;

    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((t): t is string => typeof t === "string").slice(0, 7)
        : [],
    };
  } catch {
    console.error("[gemini] summary response was not valid JSON");
    return null;
  }
}

/**
 * Generates chapter markers from a timestamped transcript using Gemini.
 * Returns null on any failure (caller falls back to manual chapters).
 * `maxSeconds` clamps timestamps to the real video duration.
 */
export async function generateChapters(
  timedTranscript: string,
  maxSeconds: number
): Promise<Chapter[] | null> {
  if (!isGeminiConfigured() || !timedTranscript.trim()) return null;

  try {
    const prompt = `You are given a timestamped transcript of a video. Each line is "[seconds] text".
Identify 3 to 8 logical chapters. Respond with ONLY valid JSON (no markdown, no code blocks).

Transcript:
${timedTranscript.slice(0, 9000)}

Respond with exactly this JSON array:
[
  { "title": "Short chapter title", "timestamp": 0 },
  { "title": "Next section", "timestamp": 92 }
]

Rules:
- timestamp is an integer number of seconds where the chapter starts
- The first chapter MUST start at timestamp 0
- timestamps must be strictly increasing and never exceed ${Math.floor(maxSeconds)}
- titles are concise (2-5 words), no numbering
- Return ONLY the JSON array, nothing else`;

    const text = await generateText(prompt);
    if (text === null) return null;

    const parsed = JSON.parse(stripFences(text));
    if (!Array.isArray(parsed)) return null;

    const cap = Math.max(0, Math.floor(maxSeconds) || Number.MAX_SAFE_INTEGER);
    const chapters: Chapter[] = parsed
      .filter(
        (c): c is { title: unknown; timestamp: unknown } =>
          c && typeof c === "object"
      )
      .map((c) => ({
        title: String((c as { title: unknown }).title ?? "").trim(),
        timestamp: Math.max(
          0,
          Math.min(cap, Math.floor(Number((c as { timestamp: unknown }).timestamp)))
        ),
      }))
      .filter((c) => c.title.length > 0 && Number.isFinite(c.timestamp))
      // de-duplicate timestamps and enforce strictly increasing order
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((c, i, arr) => i === 0 || c.timestamp > arr[i - 1].timestamp);

    if (chapters.length === 0) return null;
    if (chapters[0].timestamp !== 0) chapters[0].timestamp = 0;
    return chapters.slice(0, 8);
  } catch {
    console.error("[gemini] chapters response was not valid JSON");
    return null;
  }
}
