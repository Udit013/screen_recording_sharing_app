import { GoogleGenerativeAI } from "@google/generative-ai";

// Gemini is used for one job: a video's summary, tags and chapters. Never for
// editing. Everything here is about making the free tier go as far as
// possible without losing quality:
//   - ONE request per video (summary + tags + chapters together), where the
//     app used to make two.
//   - JSON mode and a capped output, so replies parse first time (a failed
//     parse used to cost a whole retry) and can't run long.
//   - Flash-Lite first: higher free-tier limits and faster, and summarising
//     a transcript doesn't need a bigger model. Larger models are fallbacks.
//   - Quota-aware fallback: a model that answers 429 is skipped until its
//     retry time (from the error, else 60 s); an overloaded one (500/503)
//     for 30 s; a retired one (404) for a day. Per server instance, in memory.
//   - Compact input: the transcript is merged into ~15 s blocks that cover
//     the WHOLE video within a fixed character budget, instead of cutting it
//     off (which lost the end of long videos and their chapters).
// Prompts and responses are never logged: they contain users' transcripts.

let client: GoogleGenerativeAI | null = null;

const getClient = () => {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return client;
};

/**
 * Models in order of preference. Configurable with GEMINI_MODEL (comma-
 * separated), because Google retires models on a schedule (gemini-2.0-flash
 * was retired while this app still called it).
 */
// Checked against the live API (Nov 2026) with this app's real request:
// 3.5-flash-lite 1.2 s, 2.5-flash 1.7 s, 3.1-flash-lite 9.8 s, all valid
// JSON; gemini-2.5-flash-lite is listed but retired (404); the 3.5 models
// sometimes answer 503 "high demand", hence the fallbacks.
const DEFAULT_MODELS = ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"];

export const geminiModels = (): string[] => {
  const configured = (process.env.GEMINI_MODEL ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_MODELS;
};

/** True when a key is set, i.e. a null result from below means "it failed". */
export const isGeminiConfigured = (): boolean => Boolean(process.env.GEMINI_API_KEY);

// ── Quota management ─────────────────────────────────────────────────────

const skipUntil = new Map<string, number>();
const RETIRED_MS = 24 * 3600 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;
const OVERLOADED_MS = 30 * 1000;

/** Retry delay a 429 carries (google.rpc.RetryInfo "37s"), in ms. */
export function retryDelayMs(err: unknown): number | null {
  const details = (err as { errorDetails?: Array<Record<string, unknown>> }).errorDetails;
  for (const d of details ?? []) {
    const v = d.retryDelay;
    if (typeof v === "string") {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(v.trim());
      if (m) return Math.ceil(Number(m[1]) * 1000);
    }
  }
  return null;
}

export type GeminiFailure = "quota" | "unavailable" | "error";

/** Models that can be tried right now, in preference order. */
export const availableModels = (now = Date.now()) => geminiModels().filter((m) => (skipUntil.get(m) ?? 0) <= now);

/** Test hook: forget cooldowns. */
export const resetGeminiCooldowns = () => skipUntil.clear();

/** Statuses that mean "this model can't serve you", so another may. */
const TRY_NEXT_MODEL = new Set([404, 429, 500, 503]);

/**
 * Sends one JSON-mode prompt, falling through the available models on
 * retirement (404), quota (429) or outage (500/503). Anything else (bad key,
 * blocked prompt) stops immediately rather than spending more quota.
 */
async function generateJson(prompt: string, maxOutputTokens: number): Promise<{ text: string } | { failure: GeminiFailure }> {
  const genAI = getClient();
  if (!genAI) return { failure: "error" };
  const models = availableModels();
  if (models.length === 0) return { failure: "quota" };
  let sawQuota = false;
  for (const name of models) {
    try {
      const model = genAI.getGenerativeModel({
        model: name,
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.2,
          maxOutputTokens,
          // Summaries don't need long reasoning: keep "thinking" minimal for
          // speed and token use (ignored by models without it).
          ...({ thinkingConfig: { thinkingBudget: name.includes("2.5") ? 0 : 512 } } as object),
        },
      });
      const result = await model.generateContent(prompt);
      return { text: result.response.text().trim() };
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[gemini] ${name} failed${status ? ` (HTTP ${status})` : ""}: ${message.slice(0, 200)}`);
      if (status === 429) {
        sawQuota = true;
        skipUntil.set(name, Date.now() + (retryDelayMs(err) ?? DEFAULT_COOLDOWN_MS));
      } else if (status === 404) {
        skipUntil.set(name, Date.now() + RETIRED_MS);
      } else if (status === 503 || status === 500) {
        // Overloaded ("high demand"): give it a short rest instead of hitting it on every request.
        skipUntil.set(name, Date.now() + OVERLOADED_MS);
      }
      if (!status || !TRY_NEXT_MODEL.has(status)) return { failure: "error" };
    }
  }
  return { failure: sawQuota ? "quota" : "unavailable" };
}

// ── Input ────────────────────────────────────────────────────────────────

export interface TimedLine { seconds: number; text: string }

/**
 * Merges transcript lines into blocks of at least `blockSeconds` and, if the
 * result is still over `maxChars`, doubles the block length until it fits,
 * finally trimming each block evenly. The whole video stays represented, so
 * late chapters aren't lost.
 */
export function compactTranscript(lines: TimedLine[], maxChars = 12000, blockSeconds = 15): string {
  const clean = lines.filter((l) => l.text.trim()).map((l) => ({ seconds: Math.max(0, Math.floor(l.seconds)), text: l.text.replace(/\s+/g, " ").trim() }));
  if (clean.length === 0) return "";
  const build = (block: number) => {
    const blocks: TimedLine[] = [];
    for (const l of clean) {
      const last = blocks[blocks.length - 1];
      if (last && l.seconds - last.seconds < block) last.text += ` ${l.text}`;
      else blocks.push({ ...l });
    }
    return blocks;
  };
  let block = blockSeconds, blocks = build(block);
  const size = (b: TimedLine[]) => b.reduce((s, l) => s + l.text.length + 10, 0);
  while (size(blocks) > maxChars && block < 600) { block *= 2; blocks = build(block); }
  if (size(blocks) > maxChars) {
    const per = Math.max(40, Math.floor(maxChars / blocks.length) - 10);
    blocks = blocks.map((b) => ({ ...b, text: b.text.length > per ? `${b.text.slice(0, per - 1)}…` : b.text }));
  }
  return blocks.map((b) => `[${b.seconds}] ${b.text}`).join("\n");
}

/** Too little to summarise usefully: don't spend a request on it. */
export const worthAnalyzing = (text: string) => text.trim().split(/\s+/).filter(Boolean).length >= 12;

// ── The one request ──────────────────────────────────────────────────────

export interface AiVideoAnalysis {
  summary: string;
  tags: string[];
  /** Present only when chapters were requested and valid ones came back. */
  chapters: Chapter[] | null;
}

/**
 * Summary, tags and (optionally) chapters in one request. `timed` is the
 * timestamped transcript ("[seconds] text" lines) when there is one; else
 * `context` (title/description/tags) is used and no chapters are asked for.
 * Resolves to the result, or a failure reason (quota lets callers back off).
 */
export async function analyzeVideo(input: {
  context: string;
  timed?: TimedLine[];
  wantChapters: boolean;
  maxSeconds: number;
}): Promise<{ ok: AiVideoAnalysis } | { failure: GeminiFailure | "skipped" }> {
  if (!isGeminiConfigured()) return { failure: "error" };
  const timedText = input.timed?.length ? compactTranscript(input.timed) : "";
  const body = timedText || input.context.slice(0, 12000);
  if (!worthAnalyzing(body.replace(/\[\d+\]/g, ""))) return { failure: "skipped" };
  const chapters = input.wantChapters && !!timedText;
  const max = Math.floor(input.maxSeconds);

  const prompt = `You analyze screen-recording videos for a video library.
${timedText ? "Below is the video's transcript; each line is \"[seconds] text\"." : "Below is what we know about the video."}

${body}

Respond with JSON of exactly this shape:
{
  "summary": "2-3 sentences on what the video covers",
  "tags": ["3 to 7 lowercase single-word or hyphenated tags"]${chapters ? `,
  "chapters": [{ "title": "2-5 word title", "timestamp": 0 }]` : ""}
}
Rules:
- Write the summary and tags in the transcript's main language.${chapters ? `
- chapters: 3 to 8 logical sections; the first starts at 0; timestamps are integer seconds, strictly increasing, never above ${max}.` : ""}`;

  const res = await generateJson(prompt, chapters ? 900 : 400);
  if ("failure" in res) return res;
  try {
    const parsed = JSON.parse(res.text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "")) as Record<string, unknown>;
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim().slice(0, 1200) : "";
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 7)
      : [];
    return { ok: { summary, tags, chapters: chapters ? cleanChapters(parsed.chapters, max) : null } };
  } catch {
    console.error("[gemini] response was not valid JSON");
    return { failure: "error" };
  }
}

/** Validates model-written chapters: titles, integer seconds within the video, strictly increasing, first at 0. */
export function cleanChapters(raw: unknown, maxSeconds: number): Chapter[] | null {
  if (!Array.isArray(raw)) return null;
  const cap = Math.max(0, Math.floor(maxSeconds) || Number.MAX_SAFE_INTEGER);
  const chapters: Chapter[] = raw
    .filter((c): c is { title: unknown; timestamp: unknown } => !!c && typeof c === "object")
    .map((c) => ({
      title: String(c.title ?? "").trim().slice(0, 80),
      timestamp: Math.max(0, Math.min(cap, Math.floor(Number(c.timestamp)))),
    }))
    .filter((c) => c.title.length > 0 && Number.isFinite(c.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)
    .filter((c, i, arr) => i === 0 || c.timestamp > arr[i - 1].timestamp);
  if (chapters.length === 0) return null;
  chapters[0].timestamp = 0;
  return chapters.slice(0, 8);
}
