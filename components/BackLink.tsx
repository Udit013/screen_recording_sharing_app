"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { canGoBackInApp } from "@/lib/navigation";

interface BackLinkProps {
  /** Where to go when there's no in-app history (deep link, new tab). */
  fallbackHref: string;
  /** Names the fallback destination, e.g. "Library". */
  fallbackLabel: string;
  className?: string;
}

/**
 * A quiet "← Back" that returns to the previous SnapCast page when there is
 * one, and otherwise links to a parent page. It's a real link, so it works
 * without JavaScript and middle-click opens the parent in a new tab.
 */
export default function BackLink({ fallbackHref, fallbackLabel, className }: BackLinkProps) {
  const router = useRouter();
  return (
    <Link
      href={fallbackHref}
      className={className ? `back-link ${className}` : "back-link"}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        if (canGoBackInApp()) {
          e.preventDefault();
          router.back();
        }
      }}
      aria-label={`Back (or go to ${fallbackLabel})`}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M15 18l-6-6 6-6" />
      </svg>
      Back
    </Link>
  );
}
