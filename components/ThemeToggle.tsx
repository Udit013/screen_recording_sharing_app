"use client";

// Light / Dark / System. The choice is saved in localStorage; "System"
// follows the OS setting live. The theme itself is applied before first paint
// by the inline script in app/layout.tsx, so this only handles changes.

import { useEffect, useState } from "react";

export type ThemeChoice = "light" | "dark" | "system";
const KEY = "snapcast-theme";

const apply = (choice: ThemeChoice) => {
  const dark = choice === "dark" || (choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
};

const OPTIONS: { id: ThemeChoice; label: string; icon: string }[] = [
  { id: "light", label: "Light theme", icon: "M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z" },
  { id: "dark", label: "Dark theme", icon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" },
  { id: "system", label: "Match system theme", icon: "M3 5h18v11H3zM8 20h8M12 16v4" },
];

export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [choice, setChoice] = useState<ThemeChoice>("system");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) as ThemeChoice | null;
      if (saved === "light" || saved === "dark" || saved === "system") setChoice(saved);
    } catch { /* storage unavailable: follow the system */ }
  }, []);

  useEffect(() => {
    if (choice !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => apply("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [choice]);

  const pick = (c: ThemeChoice) => {
    setChoice(c);
    apply(c);
    try { localStorage.setItem(KEY, c); } catch { /* not saved; still applied */ }
  };

  return (
    <div className={compact ? "theme-toggle is-compact" : "theme-toggle"} role="radiogroup" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button key={o.id} type="button" role="radio" aria-checked={choice === o.id} aria-label={o.label} title={o.label}
          className={choice === o.id ? "is-on" : undefined} onClick={() => pick(o.id)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={o.icon} />
          </svg>
        </button>
      ))}
    </div>
  );
}

/** Inline, render-blocking script for <head>: resolves the theme before first paint. */
export const THEME_SCRIPT = `(function(){try{var c=localStorage.getItem('${KEY}');var d=c==='dark'||((!c||c==='system')&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=d?'dark':'light'}catch(e){document.documentElement.dataset.theme='light'}})()`;
