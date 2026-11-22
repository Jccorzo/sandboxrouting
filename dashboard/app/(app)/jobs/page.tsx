"use client";

import { Fragment, useState } from "react";
import { ArrowRight, ChevronRight, Route } from "lucide-react";
import type { JobView, JobsView } from "@sandboxrouting/back/api";
import { usePoll } from "@/lib/use-poll";
import { EmptyState, Freshness, Loaded, PageHeader, TableSkeleton } from "@/components/view";
import { JobState } from "@/components/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { dateTime, relative } from "@/lib/format";
import { cn } from "@/lib/utils";

const REASON: Record<string, string> = {
  lost: "box lost",
  stopped: "box stopped outside the job",
  "provider-refused": "provider refused",
  unhealthy: "box unhealthy",
  deadline: "next step wouldn't fit before the deadline",
  "free-credit": "free usage running out",
  "circuit-open": "provider failing",
  rebalance: "a free box came free",
  oom: "out of memory, moved to a bigger box",
  "prepare-failed": "setup failed",
  orphaned: "its runner stopped",
};

export default function Jobs() {
  const view = usePoll<JobsView>("jobs?limit=200", 10_000);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Jobs" description="Multi-step work that moves between boxes when one dies, runs out of free usage or can't fit the next step. Each move says why.">
        <Freshness view={view} onRetry={view.refresh} />
      </PageHeader>
      <Loaded view={view} skeleton={<TableSkeleton rows={6} cols={6} />}>
        {(d) => {
          const now = Date.parse(d.now);
          if (!d.jobs.length)
            return (
              <EmptyState title="No jobs yet" icon={Route}>
                Jobs appear when a reporting router runs one (<code className="font-mono text-[12.5px] text-foreground">router.jobs.run</code>, <code className="font-mono text-[12.5px] text-foreground">sbr job run</code>).
              </EmptyState>
            );
          return (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-6" />
                  <TableHead>Job</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>On</TableHead>
                  <TableHead className="text-right">Moves</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.jobs.map((j) => {
                  const expanded = open === j.id;
                  return (
                    <Fragment key={j.id}>
                      <TableRow className="cursor-pointer" onClick={() => setOpen(expanded ? null : j.id)}>
                        <TableCell>
                          <button
                            type="button"
                            aria-expanded={expanded}
                            aria-label={expanded ? "Hide boxes" : "Show boxes"}
                            className="grid size-6 place-items-center rounded text-muted-foreground hover:bg-muted"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpen(expanded ? null : j.id);
                            }}
                          >
                            <ChevronRight className={cn("size-4 transition-transform duration-150", expanded && "rotate-90")} />
                          </button>
                        </TableCell>
                        <TableCell className="font-mono text-[12.5px]">{j.id}</TableCell>
                        <TableCell>
                          <JobState state={j.state} />
                          {j.state === "migrating" && j.reason && <div className="text-[12px] text-muted-foreground">{REASON[j.reason] ?? j.reason}</div>}
                        </TableCell>
                        <TableCell>
                          <Progress cursor={j.cursor} steps={j.steps} />
                        </TableCell>
                        <TableCell className="text-muted-foreground">{j.provider ?? "—"}</TableCell>
                        <TableCell className="text-right">{j.moves.length}</TableCell>
                        <TableCell className="text-muted-foreground" title={j.updatedAt}>
                          {relative(j.updatedAt, now)}
                        </TableCell>
                      </TableRow>
                      {expanded && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell />
                          <TableCell colSpan={6} className="whitespace-normal pb-5 pt-1">
                            <Placements job={j} />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          );
        }}
      </Loaded>
    </>
  );
}

function Progress({ cursor, steps }: { cursor: number; steps: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex gap-0.5" aria-hidden>
        {Array.from({ length: Math.min(steps, 12) }, (_, i) => (
          <span key={i} className={cn("h-2.5 w-1.5 rounded-[2px]", i < Math.round((cursor / steps) * Math.min(steps, 12)) ? "bg-brand" : "bg-muted")} />
        ))}
      </div>
      <span className="text-[12.5px] text-muted-foreground tabular">
        {cursor}/{steps} steps
      </span>
    </div>
  );
}

function Placements({ job }: { job: JobView }) {
  if (!job.placements.length) return <p className="text-[13px] text-muted-foreground">Not placed on a box yet.</p>;
  return (
    <ol className="space-y-2">
      {job.placements.map((p, i) => {
        const move = p.endReason && !["finished", "failed", "cancelled"].includes(p.endReason);
        return (
          <li key={`${p.sandboxId}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
            <span className="w-5 text-right text-faint tabular">{i + 1}</span>
            <span className="font-medium">{p.provider}</span>
            <span className="font-mono text-[12px] text-muted-foreground">{p.sandboxId}</span>
            {p.billing && <span className="text-muted-foreground">{p.billing}</span>}
            <span className="text-muted-foreground">
              {dateTime(p.placedAt)}
              {p.endedAt ? ` → ${dateTime(p.endedAt)}` : " → now"}
            </span>
            {move ? (
              <span className="inline-flex items-center gap-1 text-warning-ink">
                <ArrowRight className="size-3.5" /> moved: {REASON[p.endReason!] ?? p.endReason}
              </span>
            ) : p.endReason ? (
              <span className="text-muted-foreground">{p.endReason}</span>
            ) : (
              <span className="text-brand-ink">current</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
