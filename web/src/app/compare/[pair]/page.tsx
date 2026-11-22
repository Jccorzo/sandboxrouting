import Link from "next/link";
import { notFound } from "next/navigation";
import { Glyph } from "@/components/site/glyph";
import { JsonLd } from "@/components/site/json-ld";
import { CAPABILITY_LABEL, ISOLATION_LABEL, LANE_LABEL, date, duration, hours, provider, site, usd } from "@/lib/data";
import type { ProviderDoc } from "@/lib/generated-types";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const dynamicParams = false;

export function generateStaticParams() {
  return site.comparisons.map((c) => ({ pair: c.slug }));
}

const STRENGTH: Record<string, number> = { container: 0, gvisor: 1, microvm: 2, vm: 2 };

function find(slug: string) {
  return site.comparisons.find((c) => c.slug === slug);
}

export async function generateMetadata({ params }: { params: Promise<{ pair: string }> }) {
  const { pair } = await params;
  const c = find(pair);
  if (!c) return {};
  const a = provider(c.a);
  const b = provider(c.b);
  return pageMetadata({
    title: `${a.name} vs ${b.name}: free tiers, prices and isolation`,
    description: `${a.name} (${a.freeLabel}) against ${b.name} (${b.freeLabel}): free hours, prices at 2 vCPU / 4 GiB, isolation, limits, and which one sandboxrouting asks first under each strategy.`,
    path: `/compare/${c.slug}/`,
    og: `compare-${c.slug}`,
  });
}

function summary(a: ProviderDoc, b: ProviderDoc): string[] {
  const out: string[] = [];
  const fa = a.freeHoursAtReference ?? 0;
  const fb = b.freeHoursAtReference ?? 0;
  if (fa || fb) {
    const [more, less, hm, hl] = fa >= fb ? [a, b, fa, fb] : [b, a, fb, fa];
    out.push(
      `${more.name} gives more free usage at 2 vCPU and 4 GiB: about ${hours(hm)}${more.freeTier.kind === "one-time-credit" ? " once" : " a month"}, against ${hl ? `${hours(hl)}${less.freeTier.kind === "one-time-credit" ? " once" : " a month"}` : "none"} on ${less.name}.`,
    );
  }
  const [cheap, dear] = a.expectedUsdPerHour <= b.expectedUsdPerHour ? [a, b] : [b, a];
  out.push(`Once free usage is gone, ${cheap.name} is cheaper to rank: ${usd(cheap.expectedUsdPerHour, { perHour: true })} against ${usd(dear.expectedUsdPerHour, { perHour: true })}.`);
  const sa = a.isolation ? STRENGTH[a.isolation]! : -1;
  const sb = b.isolation ? STRENGTH[b.isolation]! : -1;
  if (sa !== sb) {
    const [strong, weak] = sa > sb ? [a, b] : [b, a];
    out.push(
      `${strong.name} isolates more strongly (${ISOLATION_LABEL[strong.isolation!]}) than ${weak.name} (${weak.isolation ? ISOLATION_LABEL[weak.isolation] : "not published"}), so minIsolation: "${strong.isolation}" keeps only ${strong.name}.`,
    );
  } else out.push(`Both isolate with ${a.isolation ? ISOLATION_LABEL[a.isolation] : "an unpublished method"}.`);
  return out;
}

export default async function ComparePage({ params }: { params: Promise<{ pair: string }> }) {
  const { pair } = await params;
  const c = find(pair);
  if (!c) notFound();
  const a = provider(c.a);
  const b = provider(c.b);
  const caps = Object.keys(CAPABILITY_LABEL);
  const cell = (p: ProviderDoc, ...headers: string[]) => p.readme?.cells.find((x) => headers.includes(x.header) && x.text)?.html ?? "—";

  const rows: { label: string; a: React.ReactNode; b: React.ReactNode }[] = [
    { label: "Free usage", a: a.freeLabel, b: b.freeLabel },
    { label: "Free hours at 2 vCPU, 4 GiB", a: a.freeHoursAtReference ? hours(a.freeHoursAtReference) : "—", b: b.freeHoursAtReference ? hours(b.freeHoursAtReference) : "—" },
    { label: "Free limits", a: <span dangerouslySetInnerHTML={{ __html: cell(a, "Free limits", "Notes") }} />, b: <span dangerouslySetInnerHTML={{ __html: cell(b, "Free limits", "Notes") }} /> },
    { label: "Paid after", a: <span dangerouslySetInnerHTML={{ __html: cell(a, "Paid after", "Price") }} />, b: <span dangerouslySetInnerHTML={{ __html: cell(b, "Paid after", "Price") }} /> },
    { label: "Ranked at (2 vCPU, 4 GiB)", a: usd(a.expectedUsdPerHour, { perHour: true }), b: usd(b.expectedUsdPerHour, { perHour: true }) },
    { label: "Isolation", a: a.isolation ? ISOLATION_LABEL[a.isolation] : "not published", b: b.isolation ? ISOLATION_LABEL[b.isolation] : "not published" },
    { label: "Longest sandbox", a: duration(a.maxTimeoutSec), b: duration(b.maxTimeoutSec) },
    { label: "Longest command", a: a.maxExecSec ? duration(a.maxExecSec) : "no cap", b: b.maxExecSec ? duration(b.maxExecSec) : "no cap" },
    { label: "Keys", a: a.env.join(", ") || "none", b: b.env.join(", ") || "none" },
    { label: "Terms checked", a: date(a.checked), b: date(b.checked) },
  ];

  return (
    <>
      <JsonLd data={breadcrumbLd([{ name: "Home", path: "/" }, { name: "Comparisons", path: "/compare/" }, { name: `${a.name} vs ${b.name}`, path: `/compare/${c.slug}/` }])} />
      <header className="wrap pt-14 sm:pt-20 lg:pt-24">
        <h1 data-reveal className="text-[clamp(2.4rem,1.2rem+4.6vw,4.5rem)] leading-[0.98] tracking-[-0.035em]">
          {a.name} vs {b.name}
        </h1>
        <div data-reveal className="mt-6 max-w-[64ch] space-y-3 text-[18px] leading-relaxed">
          {summary(a, b).map((s) => (
            <p key={s}>{s}</p>
          ))}
        </div>
      </header>

      <section className="wrap mt-14 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[15px] [&_code]:rounded-[4px] [&_code]:bg-tone-1 [&_code]:px-1 [&_code]:text-[13.5px]">
          <thead>
            <tr>
              <th className="w-[24%] py-3" />
              {[a, b].map((p) => (
                <th key={p.id} className="w-[38%] bg-tone-1 px-4 py-3 text-[18px] font-semibold tracking-[-0.01em]">
                  <Link href={`/providers/${p.id}/`} className="hover:underline">
                    {p.name}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-tone-2 align-top">
                <th scope="row" className="py-3 pr-4 font-normal text-muted">
                  {r.label}
                </th>
                <td className="px-4 py-3">{r.a}</td>
                <td className="px-4 py-3">{r.b}</td>
              </tr>
            ))}
            {caps.map((k) => (
              <tr key={k} className="border-b border-tone-2">
                <th scope="row" className="py-2.5 pr-4 font-normal text-muted">
                  {CAPABILITY_LABEL[k]}
                </th>
                {[a, b].map((p) => (
                  <td key={p.id} className="px-4 py-2.5">
                    {p.capabilities.includes(k) ? (
                      <span className="inline-flex items-center gap-1.5 text-green-ink">
                        <Glyph kind="ok" /> yes
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-muted">
                        <Glyph kind="skip" /> no
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="wrap mt-[var(--section)]">
        <h2 className="text-[clamp(2rem,1.3rem+2.4vw,3rem)] tracking-[-0.035em]">Which one the router asks first</h2>
        <p className="mt-4 max-w-[62ch] text-[17px] leading-relaxed">
          The router&rsquo;s own plan with only these two configured, a 10-minute request at 2 vCPU and 4 GiB, and an empty ledger, generated on{" "}
          {date(site.asOf)}.
        </p>
        <div className="mt-8 space-y-[4px]">
          {c.plans.map((pl) => (
            <div key={pl.strategy + pl.allowPaid} className="grid gap-3 bg-tone-1 p-5 md:grid-cols-[240px_minmax(0,1fr)] md:items-baseline">
              <p className="text-[16px] font-semibold">
                <code className="text-[15px]">{pl.strategy}</code>
                <span className="font-normal text-muted">, allowPaid {String(pl.allowPaid)}</span>
              </p>
              <ol className="space-y-1.5 text-[15px]">
                {pl.ordered.map((e, i) => (
                  <li key={e.provider}>
                    <span className={i === 0 ? "font-semibold text-green-ink" : "font-medium"}>
                      {i === 0 ? "First" : "Then"}: {provider(e.provider).name}
                    </span>
                    <span className="text-muted">
                      {" "}
                      ({[LANE_LABEL[e.lane] ?? e.lane, ...e.why.slice(1)].join(", ")})
                    </span>
                  </li>
                ))}
                {pl.skipped.map((s) => (
                  <li key={s.provider} className="text-muted">
                    Left out: {provider(s.provider).name}, {s.reason}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
        <p className="mt-6 text-[15px] text-muted">
          Terms change; each provider&rsquo;s pricing page is linked from its page here. Neither provider endorses this comparison.
        </p>
      </section>
    </>
  );
}
