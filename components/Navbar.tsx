"use client";
// The app shell's navigation. One component, three layouts (CSS only):
//   - desktop: a fixed sidebar (brand, Upload, sections, theme, account);
//   - the Studio editor and mid-size screens: a slim icon rail, so the
//     editor gets the width;
//   - phones: a compact top bar plus a bottom tab bar within thumb reach.
import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { authClient } from "@/lib/auth-client";
import { recordRoute } from "@/lib/navigation";
import ImageWithFallback from "./ImageWithFallback";
import ThemeToggle from "./ThemeToggle";

const ICONS = {
  library: "M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z",
  mine: "M15 10l5-3v10l-5-3M4 7h11v10H4z",
  collections: "M4 6h16M4 12h16M4 18h10",
  convert: "M4 7h13l-3-3M20 17H7l3 3",
  upload: "M12 16V4m0 0-5 5m5-5 5 5M4 20h16",
  signOut: "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11",
};

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

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
        { href: "/convert", label: "Convert", icon: ICONS.convert, active: pathname.startsWith("/convert") },
      ]
    : [];

  // The editor needs the width: collapse to the icon rail there.
  const rail = /\/video\/[^/]+\/edit/.test(pathname);

  return (
    <header className={rail ? "app-nav is-rail" : "app-nav"}>
      <Link href="/" className="app-nav-brand" aria-label="SnapCast Studio home">
        <Image src="/assets/icons/logo.svg" alt="" aria-hidden width={34} height={34} priority />
        <span className="app-nav-wordmark">
          SnapCast<span className="navbar-brand-tag" aria-hidden>Studio</span>
        </span>
      </Link>

      {user && (
        <Link href="/upload" className={pathname.startsWith("/upload") ? "app-nav-cta is-active" : "app-nav-cta"} title="Upload a video">
          <Icon d={ICONS.upload} />
          <span>Upload</span>
        </Link>
      )}

      {user && (
        <nav aria-label="Main" className="app-nav-links">
          <ul>
            {links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  className={l.active ? "app-nav-link is-active" : "app-nav-link"}
                  aria-current={l.active ? "page" : undefined}
                  title={l.label}
                >
                  <Icon d={l.icon} />
                  <span>{l.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <div className="app-nav-foot">
        <ThemeToggle />
        {user && (
          <div className="app-nav-user">
            <Link href={`/profile/${user.id}`} aria-label="Your profile" className="app-nav-avatar">
              <ImageWithFallback src={user.image ?? ""} alt="" width={34} height={34} className="rounded-full aspect-square" />
              <span className="app-nav-user-name">{user.name}</span>
            </Link>
            <button onClick={handleSignOut} className="app-nav-signout" aria-label="Sign out" title="Sign out">
              <Icon d={ICONS.signOut} />
            </button>
          </div>
        )}
      </div>
    </header>
  );
};

export default Navbar;
