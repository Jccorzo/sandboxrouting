import Link from "next/link";
import { PlanExplorer } from "@/components/diagrams/plan-explorer";
import { CopyButton } from "@/components/site/copy-button";
import { date, defaultPlan, providerNames, site } from "@/lib/data";

export function Hero() {
  const defaults = { strategy: site.defaults.strategy, allowPaid: false, needs: [] as string[], minIsolation: "" };
  return (
    <section className="relative overflow-x-clip">
      <div className="wrap grid grid-cols-1 gap-x-8 lg:grid-cols-12">
        <h1
          data-reveal
          className="pt-14 text-[clamp(2.6rem,10vw,3.4rem)] leading-[0.98] tracking-[-0.035em] sm:pt-20 lg:col-span-8 lg:pt-[112px] lg:text-[clamp(3.25rem,5.2vw,5rem)]"
        >
          Sandboxes from
          <br />
          every free tier
        </h1>
        <div className="flex flex-col gap-6 pt-6 lg:col-span-4 lg:row-start-2 lg:pt-10 lg:pr-4">
          <p data-reveal style={{ ["--i" as string]: 1 }} className="max-w-[40ch] text-[18px] leading-[1.5]">
            Ask for a sandbox. sandboxrouting picks one of {site.counts.total} providers that still has free usage left, fails over when one
            refuses, and moves your work when a box dies.
          </p>
          <div data-reveal style={{ ["--i" as string]: 2 }} className="flex flex-wrap items-center gap-3">
            <Link
              href="/quickstart/"
              className="inline-flex h-12 items-center bg-ink px-5 text-[16px] font-medium text-ground transition-[background-color,transform] hover:bg-[#2b2b29] active:scale-[0.98]"
            >
              Quickstart
            </Link>
            <span className="inline-flex h-12 items-center gap-1 bg-tone-1 pl-4 pr-2">
              <code className="text-[14px]">npm i sandboxrouting</code>
              <CopyButton text="npm i sandboxrouting" className="bg-transparent" />
            </span>
          </div>
          <p data-reveal style={{ ["--i" as string]: 3 }} className="hidden max-w-[40ch] text-[14px] leading-relaxed text-muted lg:mt-auto lg:block lg:pb-16">
            The panel is the router&rsquo;s own <code className="text-[13px]">plan()</code>, run at build time against an example ledger as of{" "}
            {date(site.asOf)}: {site.hero.ledger.slice(1).join("; ")}. Change the request and see where it goes.
          </p>
        </div>
        <div className="relative -mx-[var(--gutter)] mt-10 lg:col-span-8 lg:col-start-5 lg:row-start-2 lg:mx-0 lg:mr-[calc(-1*var(--gutter))] lg:mt-10">
          <div className="shutter">
          <div
            className="settle bg-ink [--cut:72px] sm:[--cut:192px]"
            style={{ clipPath: "polygon(0 56px, var(--cut) 56px, var(--cut) 0, 100% 0, 100% 100%, 0 100%)" }}
          >
            <div className="flex gap-10 px-4 pb-0 pt-[72px] sm:px-14 sm:pt-[112px]">
              <PlanExplorer
                initial={{ key: defaultPlan.key, plan: defaultPlan.plan }}
                defaults={defaults}
                options={site.hero.controls}
                names={providerNames()}
                total={site.counts.total}
                className="w-full max-w-[640px] shrink-0"
              />
              <ul className="hidden max-w-[24ch] space-y-3 self-start pt-2 text-[14px] leading-snug text-ground/80 2xl:block">
                <li className="text-ground">The example ledger</li>
                {site.hero.ledger.map((l) => (
                  <li key={l}>{l[0]!.toUpperCase() + l.slice(1)}.</li>
                ))}
              </ul>
            </div>
          </div>
          </div>
        </div>
        <p className="mt-5 max-w-[60ch] text-[14px] leading-relaxed text-muted lg:hidden">
          The panel is the router&rsquo;s own <code className="text-[13px]">plan()</code>, run at build time on an example ledger as of{" "}
          {date(site.asOf)}: {site.hero.ledger.slice(1).join("; ")}.
        </p>
      </div>
    </section>
  );
}
