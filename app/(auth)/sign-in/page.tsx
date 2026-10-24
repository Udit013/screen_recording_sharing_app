"use client";

import Link from "next/link";
import Image from "next/image";
import { useState } from "react";

import { authClient } from "@/lib/auth-client";

const POINTS = [
  {
    title: "Edit by editing text",
    body: "Delete a flubbed sentence from the transcript and it's gone from the video.",
    icon: "M4 6h16M4 12h10M4 18h14",
  },
  {
    title: "Tighten every pause",
    body: "One click removes the dead air. You see exactly how many seconds it saves.",
    icon: "M5 4v16M19 4v16M9 12h6",
  },
  {
    title: "Runs on your device",
    body: "Transcription and video rendering happen in your browser. Nothing to install.",
    icon: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  },
];

const SignIn = () => {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setPending(true);
    setError(null);
    try {
      // On success the browser leaves for Google, so `pending` stays true:
      // the button keeps saying so instead of looking dead during the redirect.
      const result = await authClient.signIn.social({ provider: "google" });
      if (result?.error) throw new Error(result.error.message);
    } catch {
      setPending(false);
      setError("Couldn't start Google sign-in. Check your connection and try again.");
    }
  };

  return (
    <main className="signin">
      <div className="overlay" />

      <section className="signin-panel" aria-labelledby="signin-title">
        <Link href="/" className="signin-brand">
          <Image src="/assets/icons/logo.svg" alt="" aria-hidden width={36} height={36} />
          <span>SnapCast</span>
        </Link>

        <div className="signin-card">
          <h2 id="signin-title">Welcome to SnapCast</h2>
          <p>Sign in to record, edit and share your videos.</p>

          <button
            type="button"
            onClick={handleSignIn}
            disabled={pending}
            aria-busy={pending}
            className="signin-google"
          >
            <Image src="/assets/icons/google.svg" alt="" aria-hidden width={22} height={22} />
            <span>{pending ? "Opening Google…" : "Continue with Google"}</span>
          </button>

          <p className="signin-error" role="alert">
            {error}
          </p>
          <p className="signin-note">Free to use. We only read your name, email and photo.</p>
        </div>
      </section>

      <section className="signin-pitch" aria-label="About SnapCast">
        <h1>
          Record messy. <span>Ship clean.</span>
        </h1>
        <p className="signin-lede">
          Record a demo in one take, then fix it like a doc. Built for engineers and teams who
          explain things on screen.
        </p>
        <ul>
          {POINTS.map((p) => (
            <li key={p.title}>
              <span className="signin-icon" aria-hidden>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d={p.icon} />
                </svg>
              </span>
              <div>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
};

export default SignIn;
