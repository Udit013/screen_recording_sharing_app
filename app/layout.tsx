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
    "Record a demo in one take, then edit it by editing its transcript: cut words, tighten pauses, export an MP4 and share with privacy controls, all in your browser.",
  icons: {
    icon: "/assets/icons/logo.svg",
  },
  openGraph: {
    type: "website",
    siteName: "SnapCast",
    title: "SnapCast — Screen Recording & Video Sharing",
    description:
      "Browser-native screen recording with transcript-based editing, pause removal, AI chapters and privacy-controlled sharing.",
  },
  twitter: {
    card: "summary_large_image",
    title: "SnapCast — Screen Recording & Video Sharing",
    description:
      "Browser-native screen recording with transcript-based editing, pause removal, AI chapters and privacy-controlled sharing.",
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
