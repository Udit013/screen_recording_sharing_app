"use client";

import Link from "next/link";
import Image from "next/image";

import { authClient } from "@/lib/auth-client";

const SignIn = () => {
  return (
    <main className="sign-in">
      <aside className="testimonial">
        <Link href="/">
          <Image
            src="/assets/icons/logo.svg"
            alt="SnapCast Logo"
            width={32}
            height={32}
          />
          <h1>SnapCast</h1>
        </Link>

        <div className="description">
          <section>
            <p>
              Record a demo in one take, then fix it like a doc: delete words
              from the transcript, tighten every pause, and share a clean cut.
              It all runs in your browser, with nothing to install.
            </p>
          </section>
        </div>
      </aside>

      <aside className="google-sign-in">
        <section>
          <Link href="/">
            <Image
              src="/assets/icons/logo.svg"
              alt="SnapCast Logo"
              width={40}
              height={40}
            />
            <h1>SnapCast</h1>
          </Link>
          <p>
            Create and share your very first <span>SnapCast video</span> in no
            time!
          </p>

          <button
            onClick={async () => {
              return await authClient.signIn.social({
                provider: "google",
              });
            }}
          >
            <Image
              src="/assets/icons/google.svg"
              alt="Google Icon"
              width={22}
              height={22}
            />
            <span>Sign in with Google</span>
          </button>
        </section>
      </aside>
      <div className="overlay" />
    </main>
  );
};

export default SignIn;
