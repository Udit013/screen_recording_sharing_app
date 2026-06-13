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
