import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// A retired model used to fail silently for every video. These tests pin down
// the behaviour that would have caught it: fall through on a retired model,
// stop on errors a different model can't fix, and always say what failed.

const generateContent = vi.fn();
const getGenerativeModel = vi.fn((_opts: { model: string }) => ({ generateContent }));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: class {
    getGenerativeModel = getGenerativeModel;
  },
}));

const reply = (text: string) => ({ response: { text: () => text } });
const httpError = (status: number, message = "boom") => Object.assign(new Error(message), { status });

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

  it("defaults to models that are fast enough for a serverless request", async () => {
    const { geminiModels } = await load();
    expect(geminiModels()).toEqual(["gemini-3.5-flash", "gemini-2.5-flash"]);
  });

  it("reads a comma-separated override and ignores blanks", async () => {
    process.env.GEMINI_MODEL = " model-a , ,model-b ";
    const { geminiModels } = await load();
    expect(geminiModels()).toEqual(["model-a", "model-b"]);
  });

  it("returns the analysis from the first model when it works", async () => {
    generateContent.mockResolvedValueOnce(reply('{"summary":"A demo.","tags":["demo","vercel"]}'));
    const { analyzeVideoContent } = await load();
    expect(await analyzeVideoContent("some content")).toEqual({ summary: "A demo.", tags: ["demo", "vercel"] });
    expect(getGenerativeModel).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next model when one has been retired (404)", async () => {
    generateContent
      .mockRejectedValueOnce(httpError(404, "no longer available"))
      .mockResolvedValueOnce(reply('```json\n{"summary":"Fine.","tags":["a"]}\n```'));
    const { analyzeVideoContent } = await load();
    expect(await analyzeVideoContent("content")).toEqual({ summary: "Fine.", tags: ["a"] });
    expect(getGenerativeModel.mock.calls.map((c) => c[0].model)).toEqual(["gemini-3.5-flash", "gemini-2.5-flash"]);
    // ...and the retirement is visible in the logs, not swallowed.
    expect(errorSpy.mock.calls[0][0]).toContain("gemini-3.5-flash failed (HTTP 404)");
  });

  it("also falls through on quota (429) and outages (503)", async () => {
    generateContent.mockRejectedValueOnce(httpError(429)).mockResolvedValueOnce(reply('{"summary":"ok","tags":[]}'));
    const { analyzeVideoContent } = await load();
    expect((await analyzeVideoContent("c"))?.summary).toBe("ok");
  });

  it("stops on an error another model can't fix, instead of burning quota", async () => {
    generateContent.mockRejectedValueOnce(httpError(400, "API key not valid"));
    const { analyzeVideoContent } = await load();
    expect(await analyzeVideoContent("content")).toBeNull();
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("returns null (and logs) when every model fails", async () => {
    generateContent.mockRejectedValue(httpError(404));
    const { analyzeVideoContent } = await load();
    expect(await analyzeVideoContent("content")).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("returns null and logs when the reply isn't JSON", async () => {
    generateContent.mockResolvedValueOnce(reply("Sorry, I can't do that."));
    const { analyzeVideoContent } = await load();
    expect(await analyzeVideoContent("content")).toBeNull();
    expect(errorSpy.mock.calls.at(-1)?.[0]).toContain("not valid JSON");
  });

  it("makes no request without a key or without content", async () => {
    const { analyzeVideoContent, isGeminiConfigured } = await load();
    expect(await analyzeVideoContent("   ")).toBeNull();
    delete process.env.GEMINI_API_KEY;
    expect(isGeminiConfigured()).toBe(false);
    expect(await analyzeVideoContent("content")).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("clamps and orders chapters from the model", async () => {
    generateContent.mockResolvedValueOnce(
      reply('[{"title":"Intro","timestamp":5},{"title":"Deploy","timestamp":40},{"title":"Late","timestamp":999},{"title":"Dup","timestamp":40}]')
    );
    const { generateChapters } = await load();
    const chapters = await generateChapters("[0] hi\n[40] deploy", 60);
    expect(chapters?.[0]).toEqual({ title: "Intro", timestamp: 0 }); // first chapter starts at 0
    expect(chapters?.map((c) => c.timestamp)).toEqual([0, 40, 60]); // de-duplicated, clamped to duration
  });
});
