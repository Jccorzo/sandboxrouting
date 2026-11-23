import type { MetadataRoute } from "next";

// A private dashboard: no crawler reads it, and every page also says noindex (layout.tsx,
// next.config.ts). The one exception is the bots that draw a pasted link's preview and honour
// robots.txt (X, LinkedIn): they may read the root and the sign-in page it sends them to, which
// is where the preview's tags are.
const LINK_PREVIEW_BOTS = ["Twitterbot", "LinkedInBot", "facebookexternalhit", "Slackbot-LinkExpanding", "Discordbot"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: LINK_PREVIEW_BOTS, allow: ["/$", "/login"], disallow: "/" },
      { userAgent: "*", disallow: "/" },
    ],
  };
}
