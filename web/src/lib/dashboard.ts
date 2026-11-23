// The hosted dashboard. Its root sends a visitor with no session to its sign-in page and a
// signed-in one straight in, so every "Sign in" link on the site points here. A self-hosted copy
// of the site sets NEXT_PUBLIC_DASHBOARD_URL at build time. Kept apart from links.ts, which imports
// node:path, because the nav is a client component.

export const DASHBOARD_URL = `${(process.env.NEXT_PUBLIC_DASHBOARD_URL || "https://app.sandboxrouting.com").replace(/\/+$/, "")}/`;
