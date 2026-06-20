import { GoogleGenerativeAI } from "@google/generative-ai";

let client: GoogleGenerativeAI | null = null;

const getClient = () => {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return client;
};

export interface AiVideoAnalysis {
  summary: string;
  tags: string[];
}

export async function analyzeVideoContent(
  context: string
): Promise<AiVideoAnalysis | null> {
  const genAI = getClient();
  if (!genAI || !context.trim()) return null;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

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

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();

    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const parsed = JSON.parse(cleaned) as AiVideoAnalysis;

    return {
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((t): t is string => typeof t === "string").slice(0, 7)
        : [],
    };
  } catch {
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
  const genAI = getClient();
  if (!genAI || !timedTranscript.trim()) return null;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

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

    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed = JSON.parse(cleaned);
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
    return null;
  }
}
