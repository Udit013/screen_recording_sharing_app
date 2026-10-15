// Whether the previous page in this tab was a SnapCast page.
//
// "Back" should mean the browser's back when the user navigated here from
// inside the app, but a link to a sensible parent when they arrived from a
// bookmark, an email or a pasted URL — otherwise it would take them off the
// site. document.referrer can't tell (client-side navigations don't update
// it), so the persistent navbar records route changes instead.
//
// A boolean "has navigated" isn't enough: land on A from outside, go to B,
// press the browser's back, and A would wrongly think it has an in-app page
// behind it. So this mirrors the history stack: returning to the page just
// below the top is treated as a back navigation and pops.

let stack: string[] = [];

/** Called by the navbar on every route change. */
export function recordRoute(path: string): void {
  const top = stack[stack.length - 1];
  if (top === path) return;
  if (stack.length >= 2 && stack[stack.length - 2] === path) stack.pop();
  else stack.push(path);
}

export const canGoBackInApp = (): boolean => stack.length > 1;

/** Test seam. */
export function resetNavigation(): void {
  stack = [];
}
