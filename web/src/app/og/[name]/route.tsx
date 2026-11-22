// Open Graph images as plain .png files (/og/<name>.png), so any static host serves them with an
// image type. Rendered once at build time from the same data as the pages.

import { date, provider, providers, site, usd } from "@/lib/data";
import { loadDocs } from "@/lib/docs";
import { ogImage } from "@/lib/og";

export const dynamic = "force-static";
export const dynamicParams = false;

type Spec = { title: string; line: string; accent?: boolean };

function specs(): Record<string, Spec> {
  const out: Record<string, Spec> = {
    home: {
      title: "Sandboxes from every free tier",
      line: `One router for ${site.counts.total} sandbox providers. Fails over when one refuses, moves your work when a box dies.`,
      accent: true,
    },
    routing: { title: "How a request finds a box", line: "Hard rules, a switchable strategy, failover marks, a circuit breaker, and jobs that move." },
    providers: { title: `${site.counts.total} sandbox providers`, line: `${site.counts.monthly} free every month, ${site.counts["one-time"]} with one-time credit, ${site.counts.paid} paid only.` },
    compare: { title: "Two providers at a time", line: `${site.comparisons.length} comparisons among the main free sandbox tiers.` },
    mcp: { title: "Sandboxes for your agent", line: "npx -y sandboxrouting mcp: an MCP server for Claude Code, Cursor and every other client." },
    quickstart: { title: "A sandbox in four lines", line: "npm i sandboxrouting, set a key, create a sandbox." },
    docs: { title: "Docs", line: "The README and the design docs, rendered from the repository." },
  };
  for (const p of providers) {
    out[`provider-${p.id}`] = {
      title: p.name,
      line: `${p.category === "paid" ? `Paid, about ${usd(p.expectedUsdPerHour, { perHour: true })} at 2 vCPU / 4 GiB` : `Free: ${p.freeLabel}`}. Terms checked ${date(p.checked)}.`,
      accent: p.category === "monthly" || p.category === "one-time",
    };
  }
  for (const c of site.comparisons) {
    const a = provider(c.a);
    const b = provider(c.b);
    out[`compare-${c.slug}`] = { title: `${a.name} vs ${b.name}`, line: `${a.freeLabel} against ${b.freeLabel}. Free hours, prices, isolation, and which one the router asks first.` };
  }
  for (const d of loadDocs().pages) out[`doc-${d.slug}`] = { title: d.title, line: d.summary || `From ${d.source}.` };
  return out;
}

export function generateStaticParams() {
  return Object.keys(specs()).map((name) => ({ name: `${name}.png` }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const spec = specs()[name.replace(/\.png$/, "")];
  if (!spec) return new Response("not found", { status: 404 });
  return ogImage(spec);
}
