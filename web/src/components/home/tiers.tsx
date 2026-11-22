import Link from "next/link";
import { CATEGORY_LABEL, type Category, type ProviderDoc } from "@/lib/generated-types";
import { ISOLATION_LABEL, date, providersIn, site, usd } from "@/lib/data";
import { TiersClient, type TierTab } from "./tiers-client";

/** The README's own cell under a header, as HTML, when the provider's row has one. */
export function readmeCell(p: ProviderDoc, ...headers: string[]): string | undefined {
  return p.readme?.cells.find((c) => headers.includes(c.header) && c.text && c.text !== "—")?.html;
}

const ORDER: Record<string, (a: ProviderDoc, b: ProviderDoc) => number> = {
  monthly: (a, b) => (b.freeTier.usd ?? 0) - (a.freeTier.usd ?? 0) || (b.freeHoursAtReference ?? 0) - (a.freeHoursAtReference ?? 0),
  "one-time": (a, b) => (b.freeTier.usd ?? 0) - (a.freeTier.usd ?? 0),
  paid: (a, b) => a.maxUsdPerHour - b.maxUsdPerHour,
  "self-hosted": (a, b) => a.name.localeCompare(b.name),
};

export function tierRow(p: ProviderDoc) {
  return {
    id: p.id,
    name: p.name,
    free: p.category === "paid" ? usd(p.expectedUsdPerHour, { perHour: true }) : p.freeLabel,
    limitsHtml: readmeCell(p, "Free limits", "Notes") ?? (p.freeTier.notes ? escape(p.freeTier.notes) : ""),
    paidHtml: readmeCell(p, "Paid after", "Price", "Free usage") ?? escape(usd(p.maxUsdPerHour, { perHour: true })),
    isolation: p.isolation ? ISOLATION_LABEL[p.isolation] ?? p.isolation : "Isolation not published",
    checked: p.checked ? date(p.checked) : "n/a",
  };
}

function escape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function Tiers() {
  const cats: Category[] = ["monthly", "one-time", "paid", "self-hosted"];
  const tabs: TierTab[] = cats.map((c) => {
    const list = [...providersIn(c)].sort(ORDER[c]);
    return { key: c, label: CATEGORY_LABEL[c], count: list.length, rows: list.slice(0, 8).map(tierRow) };
  });
  return (
    <section className="wrap mt-[var(--section)]" id="providers">
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <h2 data-reveal className="max-w-[16ch] text-[clamp(2.25rem,4vw,3.75rem)] tracking-[-0.035em]">
          {site.counts.total} providers, terms read by hand
        </h2>
        <Link
          href="/providers/"
          data-reveal
          className="inline-flex h-12 shrink-0 items-center justify-center bg-ink px-5 text-[16px] font-medium text-ground transition-[background-color,transform] hover:bg-[#2b2b29] active:scale-[0.98]"
        >
          All {site.counts.total} providers
        </Link>
      </div>
      <p data-reveal className="mt-5 max-w-[60ch] text-[17px] leading-relaxed">
        Each adapter carries its provider&rsquo;s free tier and prices, the page they came from and the day they were checked, between{" "}
        {date(site.oldestChecked)} and {date(site.newestChecked)}. This list is generated from those adapters at build time. Paid-only prices are
        what the router ranks by, at {site.referenceSize.cpu} vCPU and {site.referenceSize.memoryMiB / 1024} GiB.
      </p>
      <TiersClient tabs={tabs} />
    </section>
  );
}
