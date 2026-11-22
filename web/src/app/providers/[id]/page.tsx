import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeBlock } from "@/components/site/code-block";
import { JsonLd } from "@/components/site/json-ld";
import { CAPABILITY_LABEL, ISOLATION_LABEL, LANE_LABEL, date, defaultPlan, duration, hours, maybeProvider, provider, providers, site, sortedProviders, usd } from "@/lib/data";
import { CATEGORY_LABEL } from "@/lib/generated-types";
import { REPO_URL } from "@/lib/links";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const dynamicParams = false;

export function generateStaticParams() {
  return providers.map((p) => ({ id: p.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = maybeProvider(id);
  if (!p) return {};
  const free = p.category === "paid" ? `paid only, about ${usd(p.expectedUsdPerHour, { perHour: true })} at 2 vCPU / 4 GiB` : `free usage: ${p.freeLabel}`;
  return pageMetadata({
    title: `${p.name}: free tier, pricing and limits`,
    description: `${p.name} (${p.id}) through sandboxrouting: ${free}, ${p.isolation ? `${ISOLATION_LABEL[p.isolation]} isolation` : "isolation not published"}. Terms checked ${date(p.checked)} against its pricing page.`,
    path: `/providers/${p.id}/`,
    og: `provider-${p.id}`,
  });
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-6">
      <dt className="text-[15px] text-muted">{label}</dt>
      <dd className="min-w-0 text-[16px] leading-relaxed [&_a]:underline [&_a]:decoration-green [&_code]:rounded-[4px] [&_code]:bg-tone-1 [&_code]:px-1 [&_code]:text-[14px]">{children}</dd>
    </div>
  );
}

export default async function ProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = maybeProvider(id);
  if (!p) notFound();

  const list = sortedProviders();
  const at = list.findIndex((x) => x.id === p.id);
  const prev = list[(at - 1 + list.length) % list.length]!;
  const next = list[(at + 1) % list.length]!;
  const rank = defaultPlan.plan.ordered.findIndex((e) => e.provider === p.id);
  const skip = defaultPlan.plan.skipped.find((s) => s.provider === p.id);
  const pairs = site.comparisons.filter((c) => c.a === p.id || c.b === p.id);
  const tierJson =
    p.freeTier.kind === "none" || p.freeTier.kind === "unlimited"
      ? { kind: p.freeTier.kind }
      : { kind: p.freeTier.kind, ...(p.freeTier.usd !== undefined ? { usd: p.freeTier.usd } : {}), ...(p.freeTier.hours !== undefined ? { hours: p.freeTier.hours } : {}) };

  return (
    <>
      <JsonLd data={breadcrumbLd([{ name: "Home", path: "/" }, { name: "Providers", path: "/providers/" }, { name: p.name, path: `/providers/${p.id}/` }])} />
      <header className="wrap pt-14 sm:pt-20 lg:pt-24">
        <div className="grid gap-8 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <h1 data-reveal className="text-[clamp(2.6rem,1.2rem+5.2vw,5rem)] leading-[0.98] tracking-[-0.035em]">
              {p.name}
            </h1>
            <p data-reveal className="mt-5 text-[19px]">
              <code className="text-[17px]">{p.id}</code>, {CATEGORY_LABEL[p.category].toLowerCase()}
              {p.isolation ? `, ${ISOLATION_LABEL[p.isolation]} isolation` : ", isolation not published"}.
            </p>
          </div>
          <nav aria-label="Providers" className="flex items-end gap-2 text-[14px] lg:col-span-4 lg:justify-end">
            <Link href={`/providers/${prev.id}/`} className="bg-tone-1 px-3 py-2 hover:bg-tone-2">
              Previous: {prev.name}
            </Link>
            <Link href={`/providers/${next.id}/`} className="bg-tone-1 px-3 py-2 hover:bg-tone-2">
              Next: {next.name}
            </Link>
          </nav>
        </div>
      </header>

      <section className={p.category === "paid" || p.category === "off" ? "mt-12 bg-tone-1" : "mt-12 bg-green"}>
        <div className="wrap grid gap-6 py-12 sm:py-16 lg:grid-cols-12 lg:items-end">
          <p className="text-[clamp(2.25rem,1rem+4vw,4.25rem)] font-semibold leading-none tracking-[-0.035em] lg:col-span-7">
            {p.category === "paid" ? usd(p.expectedUsdPerHour, { perHour: true }) : p.freeLabel}
          </p>
          <p className="max-w-[46ch] text-[17px] leading-relaxed lg:col-span-5">
            {p.category === "paid" ? (
              <>
                No free usage the router counts. At {site.referenceSize.cpu} vCPU and {site.referenceSize.memoryMiB / 1024} GiB the router ranks it at{" "}
                {usd(p.expectedUsdPerHour, { perHour: true })}
                {p.pricing.billing === "active-cpu" ? ` (active CPU only; up to ${usd(p.maxUsdPerHour, { perHour: true })} with every vCPU busy)` : ""}. It is
                used only with <code className="text-[15px]">allowPaid</code> on.
              </>
            ) : p.freeHoursAtReference !== undefined ? (
              <>
                About {hours(p.freeHoursAtReference)} of a {site.referenceSize.cpu} vCPU, {site.referenceSize.memoryMiB / 1024} GiB sandbox
                {p.freeTier.kind === "one-time-credit" ? ", once" : " a month"}, at {usd(p.maxUsdPerHour, { perHour: true })} with every vCPU busy. The
                router reserves that much for each live box, so it never runs past the tier.
              </>
            ) : p.category === "self-hosted" ? (
              <>Runs on hardware you already have, so it costs nothing. By default it goes after the free tiers (selfHosted: after-free).</>
            ) : (
              <>{p.offByDefault}</>
            )}
          </p>
        </div>
      </section>

      <section className="wrap mt-16 grid gap-12 lg:grid-cols-12">
        <div className="lg:col-span-8">
          <h2 className="text-[clamp(1.75rem,1.2rem+1.6vw,2.5rem)] tracking-[-0.03em]">Terms</h2>
          <dl className="mt-4 divide-y divide-tone-2">
            {p.readme?.cells
              .filter((c) => c.text && c.header !== "Isolation")
              .map((c) => (
                <Fact key={c.header} label={c.header}>
                  <span dangerouslySetInnerHTML={{ __html: c.html }} />
                </Fact>
              ))}
            {p.freeTier.concurrency ? <Fact label="Free concurrency">{p.freeTier.concurrency} at once</Fact> : null}
            {p.freeTier.maxLifetimeSec ? <Fact label="Free lifetime cap">{duration(p.freeTier.maxLifetimeSec)} a sandbox</Fact> : null}
            {p.freeTier.requiresCard !== undefined ? <Fact label="Card">{p.freeTier.requiresCard ? "required" : "not required"}</Fact> : null}
            {p.freeTier.notes ? <Fact label="Adapter's note">{p.freeTier.notes}</Fact> : null}
            <Fact label="Checked">
              {p.checked ? date(p.checked) : "n/a"}
              {p.pricingUrl ? (
                <>
                  {" "}
                  against{" "}
                  <a href={p.pricingUrl} rel="noopener">
                    {p.pricingUrl.replace(/^https?:\/\//, "")}
                  </a>
                </>
              ) : null}
            </Fact>
          </dl>
          {p.readme?.footnotes.length ? (
            <div className="mt-6 space-y-3 bg-tone-1 p-5 text-[15px] leading-relaxed [&_a]:underline [&_a]:decoration-green [&_code]:text-[13.5px]">
              {p.readme.footnotes.map((f) => (
                <p key={f} dangerouslySetInnerHTML={{ __html: f }} />
              ))}
            </div>
          ) : null}

          <h2 className="mt-16 text-[clamp(1.75rem,1.2rem+1.6vw,2.5rem)] tracking-[-0.03em]">The adapter</h2>
          {p.adapterSummary ? <p className="mt-4 max-w-[68ch] text-[17px] leading-relaxed">{p.adapterSummary}</p> : null}
          <dl className="mt-4 divide-y divide-tone-2">
            <Fact label="Keys">{p.access ? <span dangerouslySetInnerHTML={{ __html: p.access.keysHtml }} /> : p.env.length ? p.env.map((e) => <code key={e} className="mr-1">{e}</code>) : "none"}</Fact>
            {p.access ? (
              <Fact label="Connects through">
                <span dangerouslySetInnerHTML={{ __html: p.access.connectsHtml }} />
              </Fact>
            ) : null}
            <Fact label="Capabilities">{p.capabilities.length ? p.capabilities.map((c) => CAPABILITY_LABEL[c] ?? c).join(", ") : "create, exec and kill; files through exec"}</Fact>
            <Fact label="Isolation">{p.isolation ? ISOLATION_LABEL[p.isolation] : "Not published, so a request with minIsolation skips it"}</Fact>
            <Fact label="Operating system">{p.os === "macos" ? "macOS (only requests with os: \"macos\" go here)" : "Linux"}</Fact>
            <Fact label="Longest sandbox">{p.maxTimeoutSec ? duration(p.maxTimeoutSec) : "no limit declared"}</Fact>
            <Fact label="Longest command">{p.maxExecSec ? duration(p.maxExecSec) : "no cap declared"}</Fact>
            <Fact label="Timeout">{p.enforcesTimeout ? "The provider stops it at the deadline" : "The provider keeps it alive, so the router deletes it at the deadline"}</Fact>
            <Fact label="Billing">{p.pricing.billing === "active-cpu" ? `vCPUs billed only while busy${p.pricing.activeCpuFloor ? `, at least ${p.pricing.activeCpuFloor * 100}%` : ""}; memory every second` : "Wall clock, every second it runs"}</Fact>
            <Fact label="Source">
              <a href={`${REPO_URL}/blob/main/${p.adapterFile}`}>{p.adapterFile}</a>, and the provider&rsquo;s{" "}
              <a href={p.homepage} rel="noopener">
                site
              </a>
            </Fact>
          </dl>
        </div>

        <aside className="space-y-10 lg:col-span-4">
          <div className="bg-tone-1 p-5">
            <p className="text-[18px] font-semibold tracking-[-0.01em]">In the example plan</p>
            <p className="mt-2 text-[15px] leading-relaxed">
              {rank >= 0 ? (
                <>
                  Ranked {rank + 1} of {defaultPlan.plan.ordered.length} under {defaultPlan.plan.strategy}, in the {LANE_LABEL[defaultPlan.plan.ordered[rank]!.lane]?.toLowerCase()}{" "}
                  lane: {defaultPlan.plan.ordered[rank]!.why.slice(1).join(", ") || "no further reason"}.
                </>
              ) : skip ? (
                <>Left out: {skip.reason}.</>
              ) : (
                "Not in the plan."
              )}
            </p>
            <Link href="/how-routing-works/#plan" className="mt-3 inline-block text-[15px] font-medium underline decoration-green">
              Change the request
            </Link>
          </div>
          {pairs.length ? (
            <div>
              <p className="text-[18px] font-semibold tracking-[-0.01em]">Compare</p>
              <ul className="mt-3 space-y-1.5 text-[15px]">
                {pairs.map((c) => {
                  const other = provider(c.a === p.id ? c.b : c.a);
                  return (
                    <li key={c.slug}>
                      <Link href={`/compare/${c.slug}/`} className="hover:underline">
                        {p.name} vs {other.name}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </aside>
      </section>

      <section className="wrap mt-16 grid gap-6 lg:grid-cols-2">
        <CodeBlock lang="ts" title="Route only here" code={`const sbx = await router.create({ providers: ["${p.id}"] });`} />
        <CodeBlock
          lang="json"
          title="Override its terms in sandboxrouting.json"
          code={JSON.stringify({ providers: { [p.id]: { freeTier: tierJson, priority: 10 } } }, null, 2)}
        />
      </section>
    </>
  );
}
