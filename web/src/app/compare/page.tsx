import Link from "next/link";
import { provider, site } from "@/lib/data";
import { COMPARE_IDS } from "@/lib/compare-set";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Sandbox provider comparisons",
  description: `Head-to-head pages for the main free sandbox tiers: ${COMPARE_IDS.map((id) => provider(id).name).join(", ")}. Free hours, prices, isolation, limits and which one sandboxrouting asks first.`,
  path: "/compare/",
  og: "compare",
});

export default function CompareIndex() {
  return (
    <>
      <header className="wrap pt-14 sm:pt-20 lg:pt-28">
        <h1 data-reveal className="text-[clamp(2.6rem,1.2rem+5.2vw,5rem)] leading-[0.98] tracking-[-0.035em]">
          Two providers at a time
        </h1>
        <p data-reveal className="mt-6 max-w-[60ch] text-[19px] leading-relaxed">
          {site.comparisons.length} pairs among the main free tiers, each built from the two adapters and the router&rsquo;s own plan for them. Pick
          a row, then a column.
        </p>
      </header>
      <section className="wrap mt-14 overflow-x-auto">
        <table className="min-w-[720px] text-[14px]">
          <thead>
            <tr>
              <th />
              {COMPARE_IDS.map((id) => (
                <th key={id} scope="col" className="px-1 pb-3 text-left align-bottom font-semibold">
                  <span className="block max-w-[80px] leading-tight">{provider(id).name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARE_IDS.map((row, i) => (
              <tr key={row}>
                <th scope="row" className="py-1 pr-4 text-left font-semibold whitespace-nowrap">
                  {provider(row).name}
                </th>
                {COMPARE_IDS.map((col, j) => {
                  const pair = site.comparisons.find((c) => (c.a === row && c.b === col) || (c.a === col && c.b === row));
                  return (
                    <td key={col} className="p-[2px]">
                      {pair && i !== j ? (
                        <Link
                          href={`/compare/${pair.slug}/`}
                          aria-label={`${provider(row).name} vs ${provider(col).name}`}
                          className={`flex h-12 w-20 items-center justify-center text-[13px] font-medium transition-colors ${j > i ? "bg-tone-1 hover:bg-ink hover:text-ground" : "bg-tone-2/60 hover:bg-ink hover:text-ground"}`}
                        >
                          vs
                        </Link>
                      ) : (
                        <span className="block h-12 w-20 bg-green" aria-hidden="true" />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="wrap mt-16">
        <ul className="columns-1 gap-8 text-[16px] sm:columns-2 lg:columns-3">
          {site.comparisons.map((c) => (
            <li key={c.slug} className="py-1">
              <Link href={`/compare/${c.slug}/`} className="hover:underline">
                {provider(c.a).name} vs {provider(c.b).name}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
