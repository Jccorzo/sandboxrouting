import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

const DESCRIPTION = "Sign in to see where your sandboxes run and what they cost.";
/** The link preview's image. The site renders it with its other cards (web/src/app/og/[name]/route.tsx). */
const OG_IMAGE = { url: "https://sandboxrouting.com/og/dashboard.png", width: 1200, height: 630, type: "image/png" };

export const metadata: Metadata = {
  title: { default: "sandboxrouting", template: "%s · sandboxrouting" },
  description: DESCRIPTION,
  // What a pasted link shows. Every page sends a visitor without a session to sign in, so one card
  // serves them all; robots.ts lets the link-preview bots read the sign-in page.
  openGraph: { title: "sandboxrouting dashboard", description: DESCRIPTION, siteName: "sandboxrouting", type: "website", images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", title: "sandboxrouting dashboard", description: DESCRIPTION, images: [OG_IMAGE.url] },
  // A private dashboard. Also X-Robots-Tag (next.config.ts) and robots.txt.
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export const viewport: Viewport = { themeColor: "#ffffff", colorScheme: "light" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
