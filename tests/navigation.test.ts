import { beforeEach, describe, expect, it } from "vitest";
import { canGoBackInApp, recordRoute, resetNavigation } from "@/lib/navigation";

describe("in-app back tracking", () => {
  beforeEach(() => resetNavigation());

  it("has nothing to go back to on the landing page", () => {
    recordRoute("/video/a");
    expect(canGoBackInApp()).toBe(false);
  });

  it("can go back after navigating inside the app", () => {
    recordRoute("/");
    recordRoute("/video/a");
    expect(canGoBackInApp()).toBe(true);
  });

  it("knows the landing page is the bottom again after the browser's back", () => {
    recordRoute("/video/a"); // arrived from an email
    recordRoute("/video/a/edit");
    recordRoute("/video/a"); // browser back
    expect(canGoBackInApp()).toBe(false);
  });

  it("treats forward navigation to a new page as a push", () => {
    recordRoute("/");
    recordRoute("/video/a");
    recordRoute("/"); // back
    recordRoute("/playlists"); // new page
    expect(canGoBackInApp()).toBe(true);
  });

  it("ignores re-renders of the same route", () => {
    recordRoute("/video/a");
    recordRoute("/video/a");
    expect(canGoBackInApp()).toBe(false);
  });
});
