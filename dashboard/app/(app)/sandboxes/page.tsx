"use client";

import { useState } from "react";
import { Boxes } from "lucide-react";
import type { SandboxesView } from "@sandboxrouting/back/api";
import { usePoll } from "@/lib/use-poll";
import { EmptyState, Freshness, Loaded, PageHeader, TableSkeleton } from "@/components/view";
import { SandboxState } from "@/components/status";
import { Segmented } from "@/components/ui/segmented";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { memory, num, relative, usd } from "@/lib/format";

const BILLING: Record<string, string> = { free: "Free", paid: "Paid", "self-hosted": "Your hardware" };

export default function Sandboxes() {
  const [view, setView] = useState<"live" | "recent">("live");
  const data = usePoll<SandboxesView>(`sandboxes?view=${view}&limit=200`, 10_000);
  return (
    <>
      <PageHeader
        title="Sandboxes"
        description={
          <>
            Each sandbox with its state as of now. A running sandbox past its deadline reads <em className="not-italic font-medium text-foreground">Expired</em>: its provider has stopped it, even if no router has said so yet.
          </>
        }
      >
        <Freshness view={data} onRetry={data.refresh} />
        <Segmented
          label="Which sandboxes"
          value={view}
          onChange={setView}
          options={[
            { value: "live", label: "Live" },
            { value: "recent", label: "Recent" },
          ]}
        />
      </PageHeader>
      <Loaded view={data} skeleton={<TableSkeleton rows={8} cols={8} />}>
        {(d) => {
          const now = Date.parse(d.now);
          if (!d.sandboxes.length)
            return (
              <EmptyState title={view === "live" ? "No live sandboxes" : "No sandboxes yet"} icon={Boxes}>
                {view === "live" ? "Nothing is creating, running or paused right now. Recent shows the ones that finished." : "Sandboxes appear here as soon as a reporting router creates them."}
              </EmptyState>
            );
          return (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sandbox</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Billing</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>{view === "live" ? "Deadline" : "Ended"}</TableHead>
                  <TableHead className="text-right">Hours</TableHead>
                  <TableHead className="text-right">GiB-h</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.sandboxes.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="font-mono text-[12.5px]">{s.id}</div>
                      <div className="text-[12px] text-muted-foreground">
                        {s.provider}
                        {Object.entries(s.metadata).map(([k, v]) => (
                          <span key={k} className="ml-2 text-faint">
                            {k}={v}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <SandboxState state={s.state} />
                      {s.state === "stopped" && s.reason && s.reason !== "killed" && <div className="text-[12px] text-muted-foreground">{s.reason === "gone" ? "gone at provider" : "at its deadline"}</div>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <span className="text-foreground">{num(s.cpu)}</span> vCPU · <span className="text-foreground">{memory(s.memoryMiB)}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{s.billing ? BILLING[s.billing] : "—"}</TableCell>
                    <TableCell className="text-muted-foreground" title={s.createdAt}>
                      {relative(s.createdAt, now)}
                    </TableCell>
                    <TableCell className="text-muted-foreground" title={(view === "live" ? s.expiresAt : s.endedAt) ?? undefined}>
                      {view === "live" ? relative(s.expiresAt, now) : s.endedAt ? relative(s.endedAt, now) : s.state === "expired" ? relative(s.expiresAt, now) : "—"}
                    </TableCell>
                    <TableCell className="text-right">{num(s.sandboxHours)}</TableCell>
                    <TableCell className="text-right">{num(s.gibHours)}</TableCell>
                    <TableCell className="text-right">{usd(s.costUsd)}</TableCell>
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
