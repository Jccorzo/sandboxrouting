"use client";

// One color per provider for the whole dashboard, so a provider is the same color on every
// chart. Assigned once from the account's providers (what back reports this month), not per
// chart: a chart that shows a subset never repaints the rest.
import { createContext, useContext, useMemo } from "react";
import type { ProvidersView } from "@sandboxrouting/back/api";
import { usePoll } from "@/lib/use-poll";
import { seriesFor } from "@/lib/series";

type Series = ReturnType<typeof seriesFor>;
const Ctx = createContext<Series | null>(null);

export function ProviderColors({ children }: { children: React.ReactNode }) {
  const view = usePoll<ProvidersView>("providers", 60_000);
  const data = view.status === "ready" ? view.data : undefined;
  const series = useMemo(() => {
    if (!data) return null;
    const weights = new Map<string, number>();
    for (const p of data.providers) weights.set(p.provider, (weights.get(p.provider) ?? 0) + p.monthUsd + p.live + 1e-9);
    return seriesFor(weights);
  }, [data]);
  return <Ctx.Provider value={series}>{children}</Ctx.Provider>;
}

/**
 * The account's series, narrowed to the providers this chart shows. Until the account's
 * providers have loaded, or for a provider they don't list, it falls back to this chart's own.
 */
export function useProviderSeries(weights: Map<string, number>): { keys: string[]; color: (k: string) => string; fold: (k: string) => string } {
  const shared = useContext(Ctx);
  return useMemo(() => {
    if (!shared) return seriesFor(weights);
    // A provider the account's list doesn't name (no snapshot yet) folds into Other, in gray.
    const keys = [...new Set([...weights.keys()].map(shared.fold))].sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)));
    return { keys, color: shared.color, fold: shared.fold };
  }, [shared, weights]);
}
