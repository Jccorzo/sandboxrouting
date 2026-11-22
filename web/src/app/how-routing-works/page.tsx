import Link from "next/link";
import { Circuit } from "@/components/diagrams/circuit";
import { Failover } from "@/components/diagrams/failover";
import { JobMove } from "@/components/diagrams/job-move";
import { Lifecycle } from "@/components/diagrams/lifecycle";
import { PlanExplorer } from "@/components/diagrams/plan-explorer";
import { RouteField } from "@/components/diagrams/route-field";
import { JsonLd } from "@/components/site/json-ld";
import { FILTERS, date, defaultPlan, lapse, providerNames, site } from "@/lib/data";
import { quotaBackoffDays } from "@/lib/faq";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "How routing works",
  description: `How sandboxrouting picks one of ${site.counts.total} sandbox providers: twelve hard rules, a switchable strategy, failover with quota, rate-limit and auth marks, a circuit breaker, and jobs that move when a box dies. Every diagram runs the router's own code.`,
  path: "/how-routing-works/",
  og: "routing",
});

function Section({ id, title, lead, children }: { id: string; title: string; lead: React.ReactNode; children: React.ReactNode }) {
  return (
    <section id={id} className="wrap mt-[var(--section)] scroll-mt-8">
      <div className="grid gap-6 lg:grid-cols-12 lg:gap-10">
        <h2 data-reveal className="text-[clamp(2rem,1.3rem+3.2vw,3.5rem)] tracking-[-0.035em] lg:col-span-5">
          {title}
        </h2>
        <div data-reveal className="max-w-[62ch] space-y-4 text-[17px] leading-relaxed lg:col-span-7 lg:pt-2">
          {lead}
        </div>
      </div>
      <div data-reveal className="mt-10">
        {children}
      </div>
    </section>
  );
}

export default function HowRoutingWorks() {
  const names = providerNames();
  const defaults = { strategy: site.defaults.strategy, allowPaid: false, needs: [] as string[], minIsolation: "" };
  const cb = site.defaults.circuitBreaker;
  const first = site.failover[0]!;
  const rate = first.attempts.find((a) => a.kind === "rate_limit")?.untilSec;
  const auth = first.attempts.find((a) => a.kind === "auth")?.untilSec;
  const jobs = site.defaults.jobs as Record<string, number | string | boolean>;

  return (
    <>
      <JsonLd data={breadcrumbLd([{ name: "Home", path: "/" }, { name: "How routing works", path: "/how-routing-works/" }])} />
      <header className="wrap pt-14 sm:pt-20 lg:pt-28">
        <h1 data-reveal className="max-w-[14ch] text-[clamp(2.6rem,1.2rem+5.2vw,5rem)] leading-[0.98] tracking-[-0.035em]">
          How a request finds a box
        </h1>
        <p data-reveal className="mt-6 max-w-[58ch] text-[19px] leading-relaxed">
          Every diagram on this page plays what the router&rsquo;s own code did when this site was built, on{" "}
          {date(site.asOf)}: real plans, a real failover, the real circuit breaker and state machines. The design behind them is in{" "}
          <Link href="/docs/routing/" className="underline decoration-green">
            docs/routing.md
          </Link>
          .
        </p>
        <nav aria-label="On this page" className="mt-8 flex flex-wrap gap-2 text-[15px]">
          {[
            ["#plan", "Rules and strategies"],
            ["#refusals", "Refusals"],
            ["#circuit", "Circuit breaker"],
            ["#lifecycle", "A sandbox's life"],
            ["#jobs", "Jobs that move"],
          ].map(([href, label]) => (
            <a key={href} href={href} className="bg-tone-1 px-3 py-2 font-medium transition-colors hover:bg-tone-2">
              {label}
            </a>
          ))}
        </nav>
      </header>

      <Section
        id="plan"
        title="Hard rules first, then a strategy"
        lead={
          <>
            <p>
              A provider that fails any of {FILTERS.length} rules is left out, with its reason recorded: no key, a missing capability, weaker
              isolation than you asked for, a rate-limit mark, an open circuit, or no free or paid usage that can take the whole request.
            </p>
            <p>
              The rules are the same under every strategy, so no strategy can route around <code className="text-[15px]">allowPaid</code> or a
              budget. A strategy only orders what is left, in lanes: free every month first, then one-time credit, your own hardware, then paid.
              The example ledger: {site.hero.ledger.join("; ")}.
            </p>
          </>
        }
      >
        <div className="hidden md:block">
          <RouteField initial={{ key: defaultPlan.key, plan: defaultPlan.plan }} defaults={defaults} options={site.hero.controls} names={names} />
        </div>
        <div className="md:hidden">
          <PlanExplorer initial={{ key: defaultPlan.key, plan: defaultPlan.plan }} defaults={defaults} options={site.hero.controls} names={names} total={site.counts.total} />
        </div>
        <div className="mt-12 grid gap-[6px] sm:grid-cols-2 lg:grid-cols-5">
          {site.strategies.map((s) => (
            <div key={s.name} className={s.name === site.defaults.strategy ? "bg-green-wash p-5" : "bg-tone-1 p-5"}>
              <p className="text-[18px] font-semibold tracking-[-0.01em]">
                <code className="text-[16px]">{s.name}</code>
              </p>
              <p className="mt-1 text-[13px] font-medium text-green-ink">{s.name === site.defaults.strategy ? "the default" : " "}</p>
              <p className="mt-2 text-[15px] leading-snug">{s.description}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="refusals"
        title="When a provider refuses"
        lead={
          <>
            <p>
              The router tries the next provider in the plan and marks the one that refused. A 429 benches it for {lapse(rate)}, a 401 or 403
              for {lapse(auth)}, and a 402 marks its free tier used up until the monthly reset.
            </p>
            <p>
              A free tier that no reset brings back is asked again after {quotaBackoffDays.slice(0, -1).join(", ")} and then every{" "}
              {quotaBackoffDays.at(-1)} days, one create at a time, while the others skip it. These are three requests through the real router
              with four scripted providers.
            </p>
          </>
        }
      >
        <Failover steps={site.failover} />
      </Section>

      <Section
        id="circuit"
        title="The circuit breaker"
        lead={
          <>
            <p>
              Network errors, 5xx and timeouts count toward a provider&rsquo;s health. {cb.failures} in a row open its circuit for{" "}
              {cb.cooldownSec} seconds, doubling with each further failure up to {cb.maxCooldownSec / 60} minutes. Then one create may probe it,
              and a success closes it.
            </p>
            <p>Health is computed from the last {site.defaults.healthSamples} outcomes whenever it is read. There is no &ldquo;open&rdquo; flag to forget to clear.</p>
          </>
        }
      >
        <Circuit points={site.circuit} cfg={cb} />
      </Section>

      <Section
        id="lifecycle"
        title="A sandbox's life"
        lead={
          <>
            <p>
              One function moves a sandbox between states, and the buttons below can only send the events it accepts. Billing is a list of
              segments, open exactly while the box is running, so a paused box costs nothing and one past its deadline is billed to the deadline.
            </p>
            <p>{site.sandbox.derived}</p>
          </>
        }
      >
        <Lifecycle cells={site.sandbox.cells} events={site.sandbox.events} />
      </Section>

      <Section
        id="jobs"
        title="Work that moves when a box dies"
        lead={
          <>
            <p>
              A job is ordered steps plus a working directory, checkpointed after every step. When its box vanishes, its provider refuses, or a
              limit is about to end it, the job continues on another box from the last checkpoint, avoiding the provider that failed it.
            </p>
            <p>
              A step marked <code className="text-[15px]">idempotent: false</code> never runs twice: if its outcome is unknown, the job fails
              instead. Defaults: {String(jobs["maxMigrations"])} migrations a job, {String(jobs["maxStepAttempts"])} attempts a step, a{" "}
              {String(jobs["leaseSec"])} s lease that a crashed runner&rsquo;s job is resumed from.
            </p>
          </>
        }
      >
        <JobMove frames={site.job.frames} steps={site.job.spec.steps} />
      </Section>
    </>
  );
}
