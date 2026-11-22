"use client";

import { Activity } from "lucide-react";
import type { ProvidersView } from "@sandboxrouting/back/api";
import { usePoll } from "@/lib/use-poll";
import { EmptyState, Freshness, Loaded, PageHeader, TableSkeleton } from "@/components/view";
import { Circuit } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { count, ms, pct, relative, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

export default function Health() {
  const view = usePoll<ProvidersView>("providers", 15_000);
  return (
    <>
      <PageHeader
        title="Health"
        description="Each provider's recent infrastructure outcomes and its circuit breaker. A provider that keeps failing is benched for a cooldown, then one create may probe it."
      >
        <Freshness view={view} onRetry={view.refresh} />
      </PageHeader>
      <Loaded view={view} skeleton={<TableSkeleton rows={6} cols={6} />}>
        {(d) => {
          const now = Date.parse(d.now);
          const rows = d.providers.filter((p) => p.health.samples > 0 || p.health.circuit !== "closed");
          if (!rows.length)
            return (
              <EmptyState title="No outcomes recorded yet" icon={Activity}>
                Health comes from creates (and boxes lost before their deadline) in the last seven days. It fills in as routers create sandboxes.
              </EmptyState>
            );
          const order = { open: 0, "half-open": 1, closed: 2 } as const;
          rows.sort((a, b) => order[a.health.circuit] - order[b.health.circuit] || a.health.successRate - b.health.successRate);
          const many = d.installs.length > 1;
          return (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Circuit</TableHead>
                  <TableHead className="text-right">Success rate</TableHead>
                  <TableHead className="text-right">Create p50</TableHead>
                  <TableHead className="text-right">Failures in a row</TableHead>
                  <TableHead>Last failure</TableHead>
                  <TableHead className="text-right">Samples</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={`${p.install}:${p.provider}`}>
                    <TableCell>
                      <div className="font-medium">{p.name}</div>
                      {many && <div className="text-[12px] text-muted-foreground">{shortId(p.install)}</div>}
                    </TableCell>
                    <TableCell>
                      <Circuit health={p.health} now={now} />
                    </TableCell>
                    <TableCell className={cn("text-right", p.health.successRate < 0.8 && "font-medium text-critical")}>{pct(p.health.successRate)}</TableCell>
                    <TableCell className="text-right">{ms(p.health.createP50Ms)}</TableCell>
                    <TableCell className={cn("text-right", p.health.consecutiveFailures > 0 && "font-medium")}>{count(p.health.consecutiveFailures)}</TableCell>
                    <TableCell className="text-muted-foreground">{p.health.lastFailureAt ? relative(p.health.lastFailureAt, now) : "—"}</TableCell>
                    <TableCell className="text-right text-muted-foreground">{count(p.health.samples)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          );
        }}
      </Loaded>
      <p className="mt-4 max-w-[70ch] text-[12.5px] text-muted-foreground">
        Success rate weighs recent outcomes most (an hour&apos;s half-life) and leans toward 90% while there are few. Refusals (quota, rate limits, bad keys) aren&apos;t failures here: they leave marks, under Refusals.
      </p>
    </>
  );
}
