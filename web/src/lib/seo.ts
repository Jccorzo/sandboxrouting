// Canonical URLs, page metadata and structured data, defined once for every page.

import type { Metadata } from "next";
import { site } from "./data";
import { REPO_URL } from "./links";

export const SITE_URL = "https://sandboxrouting.com";
export const SITE_NAME = "sandboxrouting";

/** The canonical URL of a site path. Paths end in a slash, as the static export writes them. */
export function canonical(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${SITE_URL}${p.endsWith("/") ? p : `${p}/`}`;
}

/** The page's Open Graph image, prerendered by app/og/[name]/route.tsx. */
export function ogImageRef(name: string) {
  return { url: `/og/${name}.png`, width: 1200, height: 630, type: "image/png" };
}

export function pageMetadata(opts: { title: string; description: string; path: string; og: string; absoluteTitle?: boolean }): Metadata {
  const url = canonical(opts.path);
  return {
    title: opts.absoluteTitle ? { absolute: opts.title } : opts.title,
    description: opts.description,
    alternates: { canonical: url },
    openGraph: { title: opts.title, description: opts.description, url, siteName: SITE_NAME, type: "website", locale: "en_US", images: [ogImageRef(opts.og)] },
    twitter: { card: "summary_large_image", title: opts.title, description: opts.description, images: [ogImageRef(opts.og).url] },
  };
}

export function softwareApplicationLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    url: SITE_URL,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Node.js 20 or newer",
    softwareVersion: site.version,
    license: "https://opensource.org/licenses/MIT",
    codeRepository: REPO_URL,
    downloadUrl: "https://www.npmjs.com/package/sandboxrouting",
    description: `One router for ${site.counts.total} cloud sandbox providers. It uses every free tier first, fails over when a provider refuses, tracks what each sandbox costs and moves jobs to another box when one dies. SDK, CLI, REST API and MCP server.`,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
}

export function faqLd(items: { q: string; a: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((i) => ({ "@type": "Question", name: i.q, acceptedAnswer: { "@type": "Answer", text: i.a } })),
  };
}

export function breadcrumbLd(items: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((i, n) => ({ "@type": "ListItem", position: n + 1, name: i.name, item: canonical(i.path) })),
  };
}
