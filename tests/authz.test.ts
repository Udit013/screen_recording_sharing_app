import { describe, it, expect } from "vitest";
import { canViewVideo, hasLiveShareLink } from "@/lib/authz";

const base = {
  ownerId: "owner-1",
  visibility: "private" as Visibility,
  shareToken: null as string | null,
  shareTokenExpiry: null as Date | null,
};

describe("canViewVideo", () => {
  it("allows anyone to view a public video, including anonymous callers", () => {
    const v = { ...base, visibility: "public" as Visibility };
    expect(canViewVideo(v, null)).toBe(true);
    expect(canViewVideo(v, "someone-else")).toBe(true);
  });

  it("allows the owner to view their own private video", () => {
    expect(canViewVideo(base, "owner-1")).toBe(true);
  });

  it("denies a non-owner and an anonymous caller on a private video", () => {
    expect(canViewVideo(base, "someone-else")).toBe(false);
    expect(canViewVideo(base, null)).toBe(false);
  });

  it("treats link-only as not browsable — only the owner may open it directly", () => {
    const v = { ...base, visibility: "link-only" as Visibility };
    expect(canViewVideo(v, "owner-1")).toBe(true);
    expect(canViewVideo(v, "someone-else")).toBe(false);
    expect(canViewVideo(v, null)).toBe(false);
  });
});

describe("hasLiveShareLink", () => {
  it("is true only for a token that exists and has not expired", () => {
    const future = new Date(Date.now() + 60_000);
    expect(hasLiveShareLink({ ...base, shareToken: "t", shareTokenExpiry: future })).toBe(true);
  });

  it("is false once the expiry has passed", () => {
    const past = new Date(Date.now() - 60_000);
    expect(hasLiveShareLink({ ...base, shareToken: "t", shareTokenExpiry: past })).toBe(false);
  });

  it("is false when the token was revoked (nulled out)", () => {
    const future = new Date(Date.now() + 60_000);
    expect(hasLiveShareLink({ ...base, shareToken: null, shareTokenExpiry: future })).toBe(false);
    expect(hasLiveShareLink(base)).toBe(false);
  });

  it("is false when a token exists but carries no expiry", () => {
    expect(hasLiveShareLink({ ...base, shareToken: "t", shareTokenExpiry: null })).toBe(false);
  });
});
