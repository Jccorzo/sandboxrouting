import Link from "next/link";
import { ProviderTable, type ProviderRow } from "@/components/providers/provider-table";
import { JsonLd } from "@/components/site/json-ld";
import { date, providers, site } from "@/lib/data";
import { breadcrumbLd, canonical, pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: `All ${site.counts.total} sandbox providers`,
  description: `Free tiers, prices, isolation and capabilities of the ${site.counts.total} sandbox providers sandboxrouting routes to: ${site.counts.monthly} free every month, ${site.counts["one-time"]} with one-time credit, ${site.counts.paid} paid only. Generated from each adapter, with the date its terms were checked.`,
  path: "/providers/",
  og: "providers",
});

export default function ProvidersPage() {
  const rows: ProviderRow[] = providers.map((p) => ({
    id: p.id,
    name: p.name,
    category: p.category,
    free: p.freeLabel,
    freeHours: p.freeHoursAtReference,
    isolation: p.isolation,
    capabilities: p.capabilities,
    expected: p.expectedUsdPerHour,
    max: p.maxUsdPerHour,
    activeCpu: p.pricing.billing === "active-cpu",
    checked: p.checked,
  }));
  return (
    <>
      <JsonLd data={breadcrumbLd([{ name: "Home", path: "/" }, { name: "Providers", path: "/providers/" }])} />
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "Sandbox providers sandboxrouting supports",
          numberOfItems: providers.length,
          itemListElement: providers.map((p, i) => ({ "@type": "ListItem", position: i + 1, name: p.name, url: canonical(`/providers/${p.id}/`) })),
        }}
      />
      <header className="wrap pt-14 sm:pt-20 lg:pt-28">
        <h1 data-reveal className="text-[clamp(2.6rem,1.2rem+5.2vw,5rem)] leading-[0.98] tracking-[-0.035em]">
          {site.counts.total} sandbox providers
        </h1>
        <p data-reveal className="mt-6 max-w-[62ch] text-[19px] leading-relaxed">
          {site.counts.monthly} give free usage every month, {site.counts["one-time"]} a one-time credit, {site.counts.paid} are paid only, and{" "}
          {site.counts["self-hosted"]} run on your own hardware. Every row is generated from the provider&rsquo;s adapter, whose terms were checked
          against its pricing page between {date(site.oldestChecked)} and {date(site.newestChecked)}. Prices are at {site.referenceSize.cpu} vCPU
          and {site.referenceSize.memoryMiB / 1024} GiB, as the router ranks them. Compare two side by side on the{" "}
          <Link href="/compare/" className="underline decoration-green">
            comparison pages
          </Link>
          .
        </p>
      </header>
      <section className="wrap mt-14">
        <ProviderTable rows={rows} />
      </section>
    </>
  );
}
