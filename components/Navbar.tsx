"use client";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { authClient } from "@/lib/auth-client";
import { recordRoute } from "@/lib/navigation";
import ImageWithFallback from "./ImageWithFallback";

const ICONS = {
  library: "M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z",
  mine: "M15 10l5-3v10l-5-3M4 7h11v10H4z",
  collections: "M4 6h16M4 12h16M4 18h10",
};

const Navbar = () => {
  const router = useRouter();
  const pathname = usePathname();
  const { data: session } = authClient.useSession();
  const user = session?.user;

  // The navbar persists across (root) routes, so it is the one place that
  // sees every client-side navigation (see lib/navigation.ts).
  useEffect(() => {
    recordRoute(pathname);
  }, [pathname]);

  const handleSignOut = async () => {
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => router.push("/sign-in"),
      },
    });
  };

  const links = user
    ? [
        { href: "/", label: "Library", icon: ICONS.library, active: pathname === "/" },
        {
          href: `/profile/${user.id}`,
          label: "My videos",
          icon: ICONS.mine,
          active: pathname === `/profile/${user.id}`,
        },
        { href: "/playlists", label: "Collections", icon: ICONS.collections, active: pathname.startsWith("/playlists") },
      ]
    : [];

  return (
    <header className="navbar">
      <nav aria-label="Main">
        <Link href="/" className="navbar-brand">
          <Image
            src="/assets/icons/logo.svg"
            alt="SnapCast Logo"
            width={32}
            height={32}
          />
          <h1>SnapCast</h1>
        </Link>

        {user && (
          <ul className="nav-links">
            {links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className={l.active ? "nav-link is-active" : "nav-link"}
                  aria-current={l.active ? "page" : undefined}
                  title={l.label}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d={l.icon} />
                  </svg>
                  <span>{l.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {user && (
          <figure>
            <Link href={`/profile/${user.id}`} aria-label="Your profile" className="nav-avatar">
              <ImageWithFallback
                src={user.image ?? ""}
                alt=""
                width={36}
                height={36}
                className="rounded-full aspect-square"
              />
            </Link>
            <button
              onClick={handleSignOut}
              className="cursor-pointer"
              aria-label="Sign out"
              title="Sign out"
            >
              <Image
                src="/assets/icons/logout.svg"
                alt=""
                width={24}
                height={24}
                className="rotate-180"
              />
            </button>
          </figure>
        )}
      </nav>
    </header>
  );
};

export default Navbar;
