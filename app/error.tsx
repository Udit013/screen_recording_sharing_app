"use client";

import { useEffect } from "react";
import Image from "next/image";
import Link from "next/link";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Unhandled application error:", error);
  }, [error]);

  return (
    <main className="min-h-screen flex items-center justify-center px-4">
      <div className="text-center flex flex-col items-center gap-6 max-w-md">
        <Image
          src="/assets/icons/logo.svg"
          alt="SnapCast"
          width={48}
          height={48}
        />
        <h1 className="text-3xl font-bold text-dark-100">
          Something went wrong
        </h1>
        <p className="text-gray-100">
          An unexpected error occurred. You can try again, or head back to the
          library.
        </p>
        <div className="flex gap-3">
          <button
            onClick={reset}
            className="py-3 px-6 bg-pink-100 text-white rounded-4xl font-semibold hover:opacity-90 transition-opacity cursor-pointer"
          >
            Try again
          </button>
          <Link
            href="/"
            className="py-3 px-6 border border-gray-20 text-dark-100 rounded-4xl font-semibold hover:bg-pink-10 transition-colors"
          >
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}
