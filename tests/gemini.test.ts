import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// A retired model used to fail silently for every video. These tests pin down
// the behaviour that would have caught it, plus the free-tier economics:
// one request per video, JSON mode, quota cooldowns, and compact input.

const generateContent = vi.fn();
const getGenerativeModel = vi.fn((_opts: { model: string; generationConfig?: Record<string, unknown> }) => ({ generateContent }));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel = getGenerativeModel;
  },
}));

const reply = (obj: unknown) => ({ response: { text: () => (typeof obj === "string" ? obj : JSON.stringify(obj)) } });
const httpError = (status: number, extra: Record<string, unknown> = {}) => Object.assign(new Error("boom"), { status, ...extra });
const CONTEXT = "Title: Deploying a Next.js app to Vercel\nDescription: A walkthrough of setting up environment variables and previews for every pull request.";
const timed = (n: number) => Array.from({ length: n }, (_, i) => ({ seconds: i * 5, text: `sentence number ${i} about deploying the app and checking previews` }));

describe("gemini client", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    generateContent.mockReset();
    getGenerativeModel.mockClear();
    process.env.GEMINI_API_KEY = "test-key";
    delete process.env.GEMINI_MODEL;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  const load = () => import("@/lib/gemini");

  it("prefers Flash-Lite (higher free-tier limits) and falls back to larger models", async () => {
    const { geminiModels } = await load();
    expect(geminiModels()).toEqual(["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"]);
    process.env.GEMINI_MODEL = "model-a, model-b";
    expect(geminiModels()).toEqual(["model-a", "model-b"]);
  });

  it("gets summary, tags and chapters in ONE JSON-mode request", async () => {
    generateContent.mockResolvedValueOnce(reply({ summary: "A demo.", tags: ["Demo", "vercel"], chapters: [{ title: "Intro", timestamp: 3 }, { title: "Deploy", timestamp: 40 }] }));
    const { analyzeVideo } = await load();
    const r = await analyzeVideo({ context: CONTEXT, timed: timed(20), wantChapters: true, maxSeconds: 100 });
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ ok: { summary: "A demo.", tags: ["demo", "vercel"], chapters: [{ title: "Intro", timestamp: 0 }, { title: "Deploy", timestamp: 40 }] } });
    const cfg = getGenerativeModel.mock.calls[0][0].generationConfig!;
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.maxOutputTokens).toBeLessThanOrEqual(900);
  });

  it("doesn't ask for chapters without a timed transcript or when the owner wrote their own", async () => {
    generateContent.mockResolvedValue(reply({ summary: "S", tags: ["a"] }));
    const { analyzeVideo } = await load();
    const r1 = await analyzeVideo({ context: CONTEXT, wantChapters: true, maxSeconds: 60 });
    const r2 = await analyzeVideo({ context: CONTEXT, timed: timed(20), wantChapters: false, maxSeconds: 60 });
    expect(r1).toEqual({ ok: { summary: "S", tags: ["a"], chapters: null } });
    expect(r2).toEqual({ ok: { summary: "S", tags: ["a"], chapters: null } });
    for (const call of generateContent.mock.calls) expect(String(call[0])).not.toContain('"chapters"');
  });

  it("falls through to the next model on retirement or quota, and cools those models down", async () => {
    generateContent
      .mockRejectedValueOnce(httpError(404))
      .mockRejectedValueOnce(httpError(429, { errorDetails: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }] }))
      .mockResolvedValueOnce(reply({ summary: "ok", tags: [] }));
    const { analyzeVideo, availableModels } = await load();
    const r = await analyzeVideo({ context: CONTEXT, wantChapters: false, maxSeconds: 0 });
    expect(r).toEqual({ ok: { summary: "ok", tags: [], chapters: null } });
    expect(getGenerativeModel.mock.calls.map((c) => c[0].model)).toEqual(["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-2.5-flash"]);
    // The retired and rate-limited models are skipped on the next request…
    expect(availableModels()).toEqual(["gemini-2.5-flash", "gemini-3.1-flash-lite"]);
    // …the 429 one only until its retry time, the retired one for a day.
    expect(availableModels(Date.now() + 38_000)).toEqual(["gemini-3.5-flash", "gemini-2.5-flash", "gemini-3.1-flash-lite"]);
  });

  it("reports quota exhaustion without spending requests while every model is cooling down", async () => {
    generateContent.mockRejectedValue(httpError(429));
    const { analyzeVideo } = await load();
    expect(await analyzeVideo({ context: CONTEXT, wantChapters: false, maxSeconds: 0 })).toEqual({ failure: "quota" });
    const calls = generateContent.mock.calls.length;
    expect(await analyzeVideo({ context: CONTEXT, wantChapters: false, maxSeconds: 0 })).toEqual({ failure: "quota" });
    expect(generateContent.mock.calls.length).toBe(calls); // no new requests
  });

  it("rests an overloaded (503) model briefly", async () => {
    generateContent.mockRejectedValueOnce(httpError(503)).mockResolvedValueOnce(reply({ summary: "ok", tags: [] }));
    const { analyzeVideo, availableModels } = await load();
    expect("ok" in (await analyzeVideo({ context: CONTEXT, wantChapters: false, maxSeconds: 0 }))).toBe(true);
    expect(availableModels()[0]).toBe("gemini-3.5-flash");
    expect(availableModels(Date.now() + 31_000)[0]).toBe("gemini-3.5-flash-lite");
  });

  it("stops on errors another model can't fix, and logs which model failed", async () => {
    generateContent.mockRejectedValueOnce(httpError(400));
    const { analyzeVideo } = await load();
    expect(await analyzeVideo({ context: CONTEXT, wantChapters: false, maxSeconds: 0 })).toEqual({ failure: "error" });
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("gemini-3.5-flash-lite");
  });

  it("skips content too short to summarise, and needs a key", async () => {
    const { analyzeVideo, isGeminiConfigured } = await load();
    expect(await analyzeVideo({ context: "Title: hi", wantChapters: false, maxSeconds: 0 })).toEqual({ failure: "skipped" });
    expect(generateContent).not.toHaveBeenCalled();
    delete process.env.GEMINI_API_KEY;
    expect(isGeminiConfigured()).toBe(false);
  });

  it("handles invalid JSON as a failure", async () => {
    generateContent.mockResolvedValueOnce(reply("not json"));
    const { analyzeVideo } = await load();
    expect(await analyzeVideo({ context: CONTEXT, wantChapters: false, maxSeconds: 0 })).toEqual({ failure: "error" });
  });
});

describe("compact transcript and chapter validation", async () => {
  const { compactTranscript, cleanChapters } = await import("@/lib/gemini");

  it("merges lines into blocks and keeps the whole video within the budget", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => ({ seconds: i * 3, text: `line ${i} with a fair amount of spoken words in it` }));
    const out = compactTranscript(lines, 12000);
    expect(out.length).toBeLessThanOrEqual(12000 + 200);
    expect(out.startsWith("[0] line 0")).toBe(true);
    // The last block is near the end of the video (not cut off at the start).
    const last = Number(/\[(\d+)\][^\n]*$/.exec(out)![1]);
    expect(last).toBeGreaterThan(5000);
  });

  it("validates chapters", () => {
    expect(cleanChapters([{ title: "B", timestamp: 50 }, { title: "A", timestamp: 5 }, { title: "", timestamp: 9 }, { title: "C", timestamp: 999 }], 100))
      .toEqual([{ title: "A", timestamp: 0 }, { title: "B", timestamp: 50 }, { title: "C", timestamp: 100 }]);
    expect(cleanChapters("nope", 10)).toBeNull();
  });
});
