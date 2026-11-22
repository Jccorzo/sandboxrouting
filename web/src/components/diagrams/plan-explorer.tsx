"use client";

import Link from "next/link";
import { useState } from "react";
import { FILTERS, LANE_LABEL, isFreeLane } from "@/lib/format";
import type { PlanDoc } from "@/lib/generated-types";
import { cn } from "@/lib/utils";
import { PlanControls } from "./plan-controls";
import { shownPlan, usePlan, type Controls } from "./use-plan";

export interface ExplorerProps {
  initial: { key: string; plan: PlanDoc };
  defaults: Controls;
  options: { strategies: string[]; needs: string[]; isolation: string[] };
  names: Record<string, string>;
  total: number;
  rows?: number;
  className?: string;
}

export function priceLabel(usdPerHour: number): string {
  if (usdPerHour === 0) return "$0";
  return `$${usdPerHour < 0.1 ? usdPerHour.toFixed(4) : usdPerHour.toFixed(3)}/h`;
}

export function skipCounts(plan: PlanDoc): number[] {
  const counts = new Array(13).fill(0) as number[];
  for (const s of plan.skipped) counts[s.filter] = (counts[s.filter] ?? 0) + 1;
  return counts;
}

/** The hero's fragment: a request, the hard rules it meets, and the order the strategy gives. */
export function PlanExplorer({ initial, defaults, options, names, total, rows = 7, className }: ExplorerProps) {
  const [controls, setControls] = useState<Controls>(defaults);
  const [state, retry] = usePlan(controls, initial);
  const [openFilter, setOpenFilter] = useState<number | null>(null);
  const plan = shownPlan(state);
  const counts = skipCounts(plan);
  const filtered = plan.skipped.length;
  const stale = state.status !== "ready";
  const first = plan.ordered[0];

  return (
    <div data-ui className={cn("bg-ground text-ink", className)}>
      <div className="flex items-center justify-between gap-4 bg-tone-1 px-4 py-2.5">
        <code className="truncate text-[12.5px] text-ink">
          sbr route --strategy {controls.strategy}
          {controls.needs.length ? ` --needs ${controls.needs.join(",")}` : ""}
          {controls.minIsolation ? ` --min-isolation ${controls.minIsolation}` : ""}
        </code>
        <span className="shrink-0 text-[12px] text-muted" aria-live="polite">
          {state.status === "loading" ? "planning…" : state.status === "error" ? "not loaded" : `${plan.ordered.length} in order`}
        </span>
      </div>

      <PlanControls controls={controls} onChange={setControls} options={options} className="px-4 pb-4 pt-4" />

      {state.status === "error" ? (
        <div role="alert" className="mx-4 mb-3 flex items-center justify-between gap-3 bg-tone-2 px-3 py-2 text-[13px]">
          <span>Couldn&rsquo;t load this plan ({state.message}). Showing the previous one.</span>
          <button type="button" onClick={retry} className="rounded-[5px] bg-ink px-2.5 py-1 font-medium text-ground">
            Retry
          </button>
        </div>
      ) : null}

      <div className={cn("transition-opacity duration-200", stale && "opacity-55")}>
        <div className="px-4 pb-2 text-[13px] text-muted">
          <span className="font-medium text-ink tabular">{total}</span> providers, <span className="font-medium text-ink tabular">{filtered}</span> left out by the hard rules,{" "}
          <span className="font-medium text-ink tabular">{plan.ordered.length}</span> ranked
        </div>
        <div className="grid grid-cols-6 gap-[3px] px-4 sm:grid-cols-12" role="group" aria-label="Providers each hard rule left out">
          {FILTERS.map((f) => {
            const n = counts[f.n] ?? 0;
            const on = openFilter === f.n;
            return (
              <button
                key={f.n}
                type="button"
                disabled={n === 0}
                aria-expanded={on}
                title={`${f.name}: ${n}`}
                onClick={() => setOpenFilter(on ? null : f.n)}
                className={cn(
                  "flex h-[52px] flex-col justify-between rounded-[4px] px-1.5 py-1 text-left transition-[background-color,transform] duration-150",
                  n === 0 ? "bg-tone-1 text-muted" : on ? "bg-ink text-ground" : "bg-tone-2 text-ink hover:bg-tone-3 active:scale-[0.97]",
                )}
              >
                <span className="text-[16px] font-semibold leading-none tabular">{n}</span>
                <span className="truncate text-[10.5px] leading-tight">{f.short}</span>
              </button>
            );
          })}
        </div>
        {openFilter !== null ? (
          <ul className="mx-4 mt-2 max-h-[148px] overflow-y-auto bg-tone-1 px-3 py-2 text-[12.5px]">
            {plan.skipped
              .filter((s) => s.filter === openFilter)
              .map((s) => (
                <li key={s.provider} className="flex gap-2 py-0.5">
                  <span className="w-[108px] shrink-0 font-medium">{names[s.provider] ?? s.provider}</span>
                  <span className="text-muted">{s.reason}</span>
                </li>
              ))}
          </ul>
        ) : null}

        <ol className="mt-4" aria-label={`Order under ${plan.strategy}`}>
          {plan.ordered.slice(0, rows).map((e, i) => (
            <li
              key={e.provider}
              className={cn(
                "grid grid-cols-[22px_minmax(0,1fr)_auto] items-baseline gap-x-3 px-4 py-2 sm:grid-cols-[22px_120px_minmax(0,1fr)_auto]",
                i === 0 ? "bg-green-wash" : i % 2 ? "bg-ground" : "bg-tone-1/60",
              )}
            >
              <span className={cn("text-[12px] tabular", i === 0 ? "font-semibold text-green-ink" : "text-muted")}>{i + 1}</span>
              <Link href={`/providers/${e.provider}/`} className="truncate font-medium hover:underline">
                {names[e.provider] ?? e.provider}
              </Link>
              <span className="col-start-2 row-start-2 flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted sm:col-start-3 sm:row-start-1">
                <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", isFreeLane(e.lane) ? "bg-green" : e.lane.startsWith("self") ? "bg-tone-3" : "bg-ink")} />
                <span className="truncate">
                  {LANE_LABEL[e.lane] ?? e.lane}
                  {e.why.slice(1).length ? `, ${e.why.slice(1).join(", ")}` : ""}
                </span>
              </span>
              <span className="text-right text-[12.5px] tabular">{e.billing === "free" ? <span className="font-medium text-green-ink">free</span> : priceLabel(e.usdPerHour)}</span>
            </li>
          ))}
        </ol>
        {plan.ordered.length === 0 ? (
          <p className="px-4 py-4 text-[13px]">
            No provider can take this request: the router fails it with every provider&rsquo;s reason{controls.allowPaid ? "" : ". Allowing paid usage would widen it"}.
          </p>
        ) : plan.ordered.length > rows ? (
          <p className="px-4 py-3 text-[12.5px] text-muted">
            then {plan.ordered.length - rows} more, each tried in turn if {first ? names[first.provider] ?? first.provider : "the first"} refuses
          </p>
        ) : null}
      </div>
    </div>
  );
}
