"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps, type TooltipValueType } from "recharts";
import { useProviderSeries } from "./provider-colors";
import { day as fmtDay, count } from "@/lib/format";

/** Counts per day and provider, stacked. For failovers and infrastructure failures. */
export function DailyBars({ items, days, now, label }: { items: { day: string; provider: string; count: number }[]; days: number; now: string; label: string }) {
  const weights = useMemo(() => {
    const w = new Map<string, number>();
    for (const i of items) w.set(i.provider, (w.get(i.provider) ?? 0) + i.count);
    return w;
  }, [items]);
  const series = useProviderSeries(weights);
  const rows = useMemo(() => {
    const today = Date.parse(`${now.slice(0, 10)}T00:00:00Z`);
    const byDay = new Map<string, Record<string, number | string>>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today - i * 86_400_000).toISOString().slice(0, 10);
      byDay.set(d, { day: d });
    }
    for (const i of items) {
      const row = byDay.get(i.day);
      if (!row) continue;
      const k = series.fold(i.provider);
      row[k] = ((row[k] as number | undefined) ?? 0) + i.count;
    }
    return [...byDay.values()];
  }, [items, days, now, series]);
  const top = series.keys.at(-1);

  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1" aria-label="Providers">
        {series.keys.map((k) => (
          <li key={k} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <span className="size-2.5 rounded-[3px]" style={{ background: series.color(k) }} aria-hidden />
            {k} <span className="tabular text-faint">{count(items.filter((i) => series.fold(i.provider) === k).reduce((s, i) => s + i.count, 0))}</span>
          </li>
        ))}
      </ul>
      <div className="h-[160px] w-full" role="img" aria-label={label}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="25%">
            <CartesianGrid vertical={false} stroke="#ecebe7" />
            <XAxis dataKey="day" tickLine={false} axisLine={{ stroke: "#d3d2cc" }} tick={{ fontSize: 11.5, fill: "#8a8984" }} tickFormatter={(d: string) => fmtDay(d)} minTickGap={28} />
            <YAxis tickLine={false} axisLine={false} allowDecimals={false} tick={{ fontSize: 11.5, fill: "#8a8984" }} width={32} />
            <Tooltip cursor={{ fill: "rgba(11,11,11,0.04)" }} content={(p) => <Tip {...p} color={series.color} />} />
            {series.keys.map((k) => (
              <Bar key={k} dataKey={k} stackId="a" fill={series.color(k)} stroke="#ffffff" strokeWidth={1} radius={k === top ? [3, 3, 0, 0] : 0} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Tip({ active, payload, label, color }: TooltipContentProps<TooltipValueType, string | number> & { color: (k: string) => string }) {
  if (!active || !payload?.length) return null;
  const items = payload.filter((p) => typeof p.value === "number" && p.value > 0);
  return (
    <div className="min-w-[150px] rounded-lg border bg-background px-3 py-2 text-[12.5px] shadow-[0_6px_24px_rgba(11,11,11,0.10)]">
      <div className="mb-1 font-medium">{fmtDay(String(label))}</div>
      {items.length === 0 && <div className="text-muted-foreground">None.</div>}
      {items.map((p) => (
        <div key={String(p.dataKey)} className="flex justify-between gap-4">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-[2px]" style={{ background: color(String(p.dataKey)) }} />
            {String(p.dataKey)}
          </span>
          <span className="tabular">{count(p.value as number)}</span>
        </div>
      ))}
    </div>
  );
}
