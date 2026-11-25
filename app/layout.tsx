import type { Metadata, Viewport } from "next";
import { Karla } from "next/font/google";
import "./globals.css";
import { satoshi } from "../fonts/font";
import { THEME_SCRIPT } from "@/components/ThemeToggle";

const geistKarla = Karla({
  variable: "--font-geist-karla",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"
  ),
  title: {
    default: "SnapCast Studio: record, edit and share video in your browser",
    template: "%s | SnapCast Studio",
  },
  description:
    "Record a demo in one take, then edit it by editing its transcript: cut words, tighten pauses, export an MP4 and share with privacy controls, all in your browser.",
  applicationName: "SnapCast Studio",
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-icon", sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    siteName: "SnapCast Studio",
    title: "SnapCast Studio: record, edit and share video in your browser",
    description:
      "Screen recording with transcript editing, captions in English, Hindi and Hinglish, an audio studio, multitrack audio and media conversion, all in your browser.",
  },
  twitter: {
    card: "summary_large_image",
    title: "SnapCast Studio: record, edit and share video in your browser",
    description:
      "Screen recording with transcript editing, captions in English, Hindi and Hinglish, an audio studio, multitrack audio and media conversion, all in your browser.",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2efe6" },
    { media: "(prefers-color-scheme: dark)", color: "#0f0f0e" },
  ],
};

export default function Layout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body
        className={`${geistKarla.variable} ${satoshi.variable} font-karla antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
