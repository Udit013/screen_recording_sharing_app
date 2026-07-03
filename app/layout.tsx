import type { Metadata } from "next";
import { Karla } from "next/font/google";
import "./globals.css";
import { satoshi } from "../fonts/font";

const geistKarla = Karla({
  variable: "--font-geist-karla",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000"
  ),
  title: {
    default: "SnapCast — Screen Recording & Video Sharing",
    template: "%s | SnapCast",
  },
  description:
    "Record your screen with webcam overlay, get AI-generated summaries and chapters, and share videos with privacy controls — all from your browser.",
  icons: {
    icon: "/assets/icons/logo.svg",
  },
  openGraph: {
    type: "website",
    siteName: "SnapCast",
    title: "SnapCast — Screen Recording & Video Sharing",
    description:
      "Browser-native screen recording with AI summaries, chapters, and privacy-controlled sharing.",
  },
  twitter: {
    card: "summary_large_image",
    title: "SnapCast — Screen Recording & Video Sharing",
    description:
      "Browser-native screen recording with AI summaries, chapters, and privacy-controlled sharing.",
  },
};

export default function Layout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistKarla.variable} ${satoshi.variable} font-karla antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
