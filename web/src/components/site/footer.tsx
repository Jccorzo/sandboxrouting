import Link from "next/link";
import { date, site } from "@/lib/data";
import { DASHBOARD_URL } from "@/lib/dashboard";
import { REPO_URL } from "@/lib/links";
import { Mark } from "./mark";

export const TRADEMARK_NOTE = "The sandboxrouting name and logo are not covered by the MIT license.";

const NAV = [
  { href: "/quickstart/", label: "Quickstart" },
  { href: "/how-routing-works/", label: "How it routes" },
  { href: "/providers/", label: "Providers" },
  { href: "/compare/", label: "Comparisons" },
  { href: "/docs/", label: "Docs" },
  { href: "/mcp/", label: "MCP server" },
];

/** The close of every page: the last two rows of a board of filled tiles. */
export function Footer() {
  return (
    <footer className="mt-[var(--section)] px-2 pb-2 sm:px-3 sm:pb-3">
      <div className="grid grid-cols-2 gap-[6px] sm:gap-2 lg:grid-cols-12">
        <div className="order-3 col-span-2 flex min-h-[220px] flex-col justify-between bg-tone-1 p-5 lg:order-none lg:col-span-4">
          <p className="max-w-[30ch] text-[22px] font-medium leading-snug tracking-[-0.01em]">
            One router for {site.counts.total} sandbox providers, free usage first.
          </p>
          <div className="mt-8 space-y-1.5 text-[13px] text-muted">
            <p>
              MIT licensed. {TRADEMARK_NOTE}
            </p>
            <p>Not affiliated with or endorsed by any provider; their names are trademarks of their owners.</p>
          </div>
        </div>
        <nav aria-label="Footer" className="order-4 min-h-[220px] bg-tone-1 p-5 lg:order-none lg:col-span-3">
          <ul className="space-y-2 text-[16px]">
            {NAV.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="hover:text-green-ink hover:underline">
                  {l.label}
                </Link>
              </li>
            ))}
            <li>
              <a href={DASHBOARD_URL} className="hover:text-green-ink hover:underline">
                Dashboard
              </a>
            </li>
          </ul>
        </nav>
        <div className="order-5 flex min-h-[220px] flex-col justify-between bg-tone-1 p-5 lg:order-none lg:col-span-2">
          <p className="text-[16px] leading-snug">Terms checked against each provider&rsquo;s pricing page</p>
          <p className="text-[20px] font-medium leading-tight tabular">
            {date(site.oldestChecked)} to {date(site.newestChecked)}
          </p>
        </div>
        <div className="order-6 flex min-h-[220px] flex-col justify-between bg-tone-1 p-5 lg:order-none lg:col-span-3">
          <p className="text-[16px]">Source, issues and releases</p>
          <div className="space-y-1">
            <a href={REPO_URL} className="block text-[20px] font-medium hover:text-green-ink hover:underline">
              GitHub
            </a>
            <a href="https://www.npmjs.com/package/sandboxrouting" className="block text-[20px] font-medium hover:text-green-ink hover:underline">
              npm
            </a>
          </div>
        </div>
        <div className="order-1 col-span-2 flex min-h-[160px] items-center justify-center overflow-hidden bg-ink lg:order-none lg:col-span-8 lg:min-h-[320px]">
          <span className="flex items-center gap-[0.18em] whitespace-nowrap text-[clamp(2.2rem,7.4vw,7rem)] font-semibold leading-none tracking-[-0.05em] text-ground" aria-hidden="true">
            <Mark size={1} className="h-[0.62em] w-[0.62em]" inverse />
            sandboxrouting
          </span>
        </div>
        <Link
          href="/mcp/"
          className="group order-2 col-span-2 flex min-h-[160px] flex-col justify-between bg-green p-5 text-ink transition-colors hover:bg-[#1fc163] lg:order-none lg:col-span-4 lg:min-h-[320px]"
        >
          <span className="text-[28px] font-semibold leading-tight tracking-[-0.03em]">Give your agent sandboxes</span>
          <svg className="self-end transition-transform duration-300 group-hover:translate-x-1.5" width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden="true">
            <path d="M8 28h38M30 12l16 16-16 16" stroke="currentColor" strokeWidth="4" />
          </svg>
        </Link>
      </div>
    </footer>
  );
}
