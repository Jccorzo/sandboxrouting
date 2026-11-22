// Which providers get head-to-head pages. A choice, not data: the main free tiers, monthly and
// one-time. Every id is checked against the registry when the data is generated, so a renamed
// or removed provider fails the build instead of leaving a dead page.

export const COMPARE_IDS = ["modal", "e2b", "daytona", "vercel", "freestyle", "northflank", "cloudflare", "blaxel", "fly", "upstash"] as const;

export const pairSlug = (a: string, b: string) => `${a}-vs-${b}`;
