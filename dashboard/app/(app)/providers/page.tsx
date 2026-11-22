"use client";

import { Layers } from "lucide-react";
import type { ProvidersView } from "@sandboxrouting/back/api";
import { usePoll } from "@/lib/use-poll";
import { EmptyState, Freshness, Loaded, PageHeader, TableSkeleton } from "@/components/view";
import { Availability, FreeMeter } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { count, shortId, usd } from "@/lib/format";

export default function Providers() {
  const view = usePoll<ProvidersView>("providers", 20_000);
  return (
    <>
      <PageHeader title="Providers" description="Spend this month against the free usage each provider has left, as your routers' config and ledgers see it.">
        <Freshness view={view} onRetry={view.refresh} />
      </PageHeader>
      <Loaded view={view} skeleton={<TableSkeleton rows={6} cols={6} />}>
        {(d) => {
          if (!d.providers.length)
            return (
              <EmptyState title="No providers reported yet" icon={Layers}>
                A router reports the providers it has keys for, and any it has used, the first time it writes to its ledger.
              </EmptyState>
            );
          const now = Date.parse(d.now);
          const many = d.installs.length > 1;
          // Biggest spend first.
          const rows = [...d.providers].sort((a, b) => b.monthUsd - a.monthUsd || a.provider.localeCompare(b.provider));
          return (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Free usage left</TableHead>
                  <TableHead className="text-right">Spent this month</TableHead>
                  <TableHead className="text-right">Paid this month</TableHead>
                  <TableHead className="text-right">Live</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <TableRow key={`${p.install}:${p.provider}`}>
                    <TableCell>
                      <div className="font-medium">{p.name}</div>
                      <div className="text-[12px] text-muted-foreground">
                        {p.provider}
                        {p.selfHosted ? " · self-hosted" : ""}
                        {many ? ` · ${shortId(p.install)}` : ""}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Availability p={p} now={now} />
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <FreeMeter free={p.free} now={now} />
                    </TableCell>
                    <TableCell className="text-right">{usd(p.monthUsd)}</TableCell>
                    <TableCell className="text-right">{p.paidMonthUsd > 0 ? <span className="font-medium">{usd(p.paidMonthUsd)}</span> : <span className="text-muted-foreground">$0</span>}</TableCell>
                    <TableCell className="text-right">
                      {count(p.live)}
                      {p.concurrency ? <span className="text-muted-foreground"> / {p.concurrency}</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          );
        }}
      </Loaded>
    </>
  );
}
