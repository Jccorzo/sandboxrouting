import type { Metadata, Viewport } from "next";
import { Albert_Sans, JetBrains_Mono } from "next/font/google";
import { Footer } from "@/components/site/footer";
import { Nav } from "@/components/site/nav";
import { Reveal } from "@/components/site/reveal";
import { TooltipProvider } from "@/components/ui/tooltip";
import { site } from "@/lib/data";
import { SITE_NAME, SITE_URL, ogImageRef } from "@/lib/seo";
import "./globals.css";

const albert = Albert_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-albert", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jetbrains", display: "swap" });

const description = `One router for ${site.counts.total} cloud sandbox providers. It uses every free tier first, fails over when a provider refuses, and moves your work to another box when one dies. SDK, CLI, REST API and MCP server. MIT.`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${SITE_NAME}: one router for every sandbox provider`, template: `%s · ${SITE_NAME}` },
  description,
  applicationName: SITE_NAME,
  alternates: { canonical: `${SITE_URL}/` },
  openGraph: { siteName: SITE_NAME, type: "website", locale: "en_US", url: `${SITE_URL}/`, description, images: [ogImageRef("home")] },
  twitter: { card: "summary_large_image" },
  icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
};

export const viewport: Viewport = { themeColor: "#ffffff", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${albert.variable} ${mono.variable}`}>
      <body className="min-h-dvh bg-ground text-ink">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:bg-ink focus:px-4 focus:py-2 focus:text-ground">
          Skip to content
        </a>
        <TooltipProvider delayDuration={150}>
          <Nav />
          <main id="main">{children}</main>
          <Footer />
        </TooltipProvider>
        <Reveal />
      </body>
    </html>
  );
}
