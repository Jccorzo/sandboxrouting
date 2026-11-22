"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { MarkView, RefusalsView } from "@sandboxrouting/back/api";
import { usePoll } from "@/lib/use-poll";
import { EmptyState, Freshness, Loaded, PageHeader, Section, TableSkeleton } from "@/components/view";
import { Badge } from "@/components/status";
import { DailyBars } from "@/components/daily-bars";
import { Segmented } from "@/components/ui/segmented";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateTime, relative, shortId } from "@/lib/format";
import { Ban, CreditCard, KeyRound, Zap } from "lucide-react";

const KIND: Record<MarkView["kind"], { label: string; icon: typeof Ban; tone: "warning" | "critical" }> = {
  quota: { label: "Free credit used up", icon: CreditCard, tone: "warning" },
  rate_limit: { label: "Rate limited", icon: Ban, tone: "warning" },
  auth: { label: "Key refused", icon: KeyRound, tone: "critical" },
};

export default function Refusals() {
  const [range, setRange] = useState<"7" | "30">("30");
  const view = usePoll<RefusalsView>(`refusals?days=${range}`, 20_000);
  return (
    <>
      <PageHeader title="Refusals and failovers" description="When a provider says no (credit used up, too many requests, a bad key), the router marks it and moves on to the next one. This is where that shows.">
        <Freshness view={view} onRetry={view.refresh} />
        <Segmented
          label="Range"
          value={range}
          onChange={setRange}
          options={[
            { value: "7", label: "7 days" },
            { value: "30", label: "30 days" },
          ]}
        />
      </PageHeader>
      <Loaded view={view} skeleton={<TableSkeleton rows={4} cols={5} />}>
        {(d) => {
          const now = Date.parse(d.now);
          const many = new Set([...d.inForce, ...d.refusals].map((m) => m.install)).size > 1;
          return (
            <>
              <Section title="Marks in force" description="Providers held back right now. A quota mark that has lapsed is half-open: one free create may check whether the free tier is back.">
                {d.inForce.length === 0 ? (
                  <EmptyState title="Nothing is held back" icon={ShieldCheck}>
                    Every provider your routers know can take requests.
                  </EmptyState>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Provider</TableHead>
                        <TableHead>Refusal</TableHead>
                        <TableHead>Standing</TableHead>
                        <TableHead>Until</TableHead>
                        <TableHead className="text-right">In a row</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.inForce.map((m) => {
                        const k = KIND[m.kind];
                        return (
                          <TableRow key={`${m.install}:${m.provider}:${m.kind}`}>
                            <TableCell className="font-medium">
                              {m.provider}
                              {many && <span className="ml-2 text-[12px] font-normal text-muted-foreground">{shortId(m.install)}</span>}
                            </TableCell>
                            <TableCell>
                              <Badge tone={k.tone} icon={k.icon}>
                                {k.label}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              {m.standing === "half-open" ? (
                                <Badge tone="warning" icon={Zap}>
                                  Half-open
                                </Badge>
                              ) : (
                                <span className="text-[13px]">In force</span>
                              )}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{m.standing === "half-open" ? `lapsed ${relative(m.until, now)}` : relative(m.until, now)}</TableCell>
                            <TableCell className="text-right">{m.refusals ?? "—"}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </Section>

              <Section title="Failed creates" description="Creates a provider failed or refused. The router then tries the request's next candidate, when it has one.">
                {d.failedCreates.length ? (
                  <DailyBars items={d.failedCreates} days={d.days} now={d.now} label={`Failed creates per day by provider, last ${d.days} days`} />
                ) : (
                  <EmptyState title="No failed creates in this range">Every create landed on the first provider the router tried.</EmptyState>
                )}
              </Section>

              <Section title="Refusal history" description="Each refusal that set a mark, newest first. Kept after the mark is cleared.">
                {d.refusals.length ? (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>Provider</TableHead>
                        <TableHead>Refusal</TableHead>
                        <TableHead>Held back until</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {d.refusals.map((r) => {
                        const k = KIND[r.kind];
                        return (
                          <TableRow key={`${r.install}:${r.provider}:${r.kind}:${r.at}`}>
                            <TableCell className="text-muted-foreground">{dateTime(r.at)}</TableCell>
                            <TableCell className="font-medium">{r.provider}</TableCell>
                            <TableCell>
                              <Badge tone={k.tone} icon={k.icon}>
                                {k.label}
                                {r.refusals && r.refusals > 1 ? ` (${r.refusals}× in a row)` : ""}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-muted-foreground">{dateTime(r.until)}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                ) : (
                  <EmptyState title="No refusals in this range">No provider refused a request.</EmptyState>
                )}
              </Section>

              {d.infraFailures.length > 0 && (
                <Section title="Infrastructure failures" description="Transient errors and boxes lost before their deadline: what feeds each provider's circuit breaker.">
                  <DailyBars items={d.infraFailures} days={d.days} now={d.now} label={`Infrastructure failures per day by provider, last ${d.days} days`} />
                </Section>
              )}
            </>
          );
        }}
      </Loaded>
    </>
  );
}
