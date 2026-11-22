"use client";

import { useMemo, useState } from "react";
import { Boxes } from "lucide-react";
import type { UsageView } from "@sandboxrouting/back/api";
import { usePoll } from "@/lib/use-poll";
import { EmptyState, Freshness, Loaded, PageHeader, Section, Stat, TableSkeleton } from "@/components/view";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { UsageChart } from "@/components/usage-chart";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { count, num, pct, usd } from "@/lib/format";
import { useProviderSeries } from "@/components/provider-colors";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
] as const;

export default function Overview() {
  const [range, setRange] = useState<"7" | "30" | "90">("30");
  const usage = usePoll<UsageView>(`usage?days=${range}`, 30_000);

  return (
    <>
      <PageHeader title="Overview" description="How your sandbox workloads spread across providers: what ran where, for how long, holding how much memory.">
        <Freshness view={usage} onRetry={usage.refresh} />
        <Segmented label="Range" value={range} onChange={setRange} options={RANGES} />
      </PageHeader>
      <Loaded view={usage} skeleton={<OverviewSkeleton />}>
        {(u) => (u.points.length === 0 && u.totals.live === 0 && u.installs.length === 0 ? <NoData /> : <OverviewBody u={u} />)}
      </Loaded>
    </>
  );
}

function OverviewBody({ u }: { u: UsageView }) {
  // TODO(owner): "hushrun memory used" was mentioned but not defined (what it measures, and
  // from which source). Until it is, memory is shown only as GiB-hours: memoryMiB / 1024 × the
  // billing segments' hours, which back computes from the router's records.
  const spread = useMemo(() => {
    const by = new Map<string, { provider: string; sandboxHours: number; gibHours: number; usd: number; usdUnknown: boolean }>();
    for (const p of u.points) {
      const r = by.get(p.provider) ?? { provider: p.provider, sandboxHours: 0, gibHours: 0, usd: 0, usdUnknown: false };
      r.sandboxHours += p.sandboxHours;
      r.gibHours += p.gibHours;
      if (p.usd === null) r.usdUnknown = true;
      else r.usd += p.usd;
      by.set(p.provider, r);
    }
    return [...by.values()].sort((a, b) => b.sandboxHours - a.sandboxHours);
  }, [u.points]);
  const weights = useMemo(() => new Map(spread.map((s) => [s.provider, s.sandboxHours])), [spread]);
  const series = useProviderSeries(weights);
  const totalHours = u.totals.sandboxHours;

  return (
    <>
      <div className="grid grid-cols-2 gap-y-5 border-y py-5 sm:grid-cols-5 sm:divide-x">
        <Stat label="Live now" value={count(u.totals.live)} hint="creating or running" />
        <Stat label="Sandboxes created" value={count(u.totals.sandboxes)} hint={`last ${u.days} days`} />
        <Stat label="Sandbox-hours" value={num(u.totals.sandboxHours)} />
        <Stat label="Memory" value={<>{num(u.totals.gibHours)}<span className="ml-1 text-[13px] font-medium text-muted-foreground">GiB-h</span></>} hint="memory held while running" />
        <Stat label="Spend" value={usd(u.totals.usd)} hint={u.totals.usdUnknown ? "some prices not reported yet" : "at list price, upper bound"} />
      </div>

      <Section title="Usage over time" description={`Per day and provider, last ${u.days} days.`} className="mt-10">
        {u.points.length ? (
          <UsageChart points={u.points} from={u.from} days={u.days} />
        ) : (
          <EmptyState title="Nothing ran in this range">Live sandboxes count from the moment they start. Try a longer range.</EmptyState>
        )}
      </Section>

      {spread.length > 0 && (
        <Section title="Where it ran" description="Share of sandbox-hours by provider, with the memory and spend behind it.">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead className="w-[38%]">Share of sandbox-hours</TableHead>
                <TableHead className="text-right">Sandbox-hours</TableHead>
                <TableHead className="text-right">Memory GiB-h</TableHead>
                <TableHead className="text-right">Spend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {spread.map((s) => {
                const share = totalHours > 0 ? s.sandboxHours / totalHours : 0;
                return (
                  <TableRow key={s.provider}>
                    <TableCell>
                      <span className="inline-flex items-center gap-2 font-medium">
                        <span className="size-2.5 rounded-[3px]" style={{ background: series.color(s.provider) }} aria-hidden />
                        {s.provider}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-foreground/80" style={{ width: `${share * 100}%` }} />
                        </div>
                        <span className="w-12 text-right text-[12.5px] text-muted-foreground tabular">{pct(share)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">{num(s.sandboxHours)}</TableCell>
                    <TableCell className="text-right">{num(s.gibHours)}</TableCell>
                    <TableCell className="text-right">{s.usdUnknown ? <span title="back has no prices for this provider yet">—</span> : usd(s.usd)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>
      )}
    </>
  );
}

function NoData() {
  return (
    <EmptyState title="No router has reported yet" icon={Boxes}>
      <p>
        Turn on reporting in a router and its sandboxes show up here within seconds. Make an <strong className="font-medium text-foreground">ingest</strong> key under API keys, then set{" "}
        <code className="font-mono text-[12.5px] text-foreground">SBR_REPORT_URL</code> and <code className="font-mono text-[12.5px] text-foreground">SBR_REPORT_TOKEN</code> where the router runs, or{" "}
        <code className="font-mono text-[12.5px] text-foreground">report: {"{ url, token }"}</code> in its config.
      </p>
    </EmptyState>
  );
}

function OverviewSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-2 gap-6 border-y py-5 sm:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-16" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-12 h-[300px] w-full" />
      <div className="mt-10">
        <TableSkeleton rows={4} cols={5} />
      </div>
    </div>
  );
}
