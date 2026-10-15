// Whether the previous page in this tab was a SnapCast page.
//
// "Back" should mean the browser's back when the user navigated here from
// inside the app, but a link to a sensible parent when they arrived from a
// bookmark, an email or a pasted URL — otherwise it would take them off the
// site. document.referrer can't tell (client-side navigations don't update
// it), so the persistent navbar records route changes instead.

let navigatedInApp = false;
let lastPath: string | null = null;

/** Called by the navbar on every route change. */
export function recordRoute(path: string): void {
  if (lastPath !== null && lastPath !== path) navigatedInApp = true;
  lastPath = path;
}

export const canGoBackInApp = (): boolean => navigatedInApp;
