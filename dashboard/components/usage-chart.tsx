"use client";

import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps, type TooltipValueType } from "recharts";
import type { UsagePoint } from "@sandboxrouting/back/api";
import { useProviderSeries } from "./provider-colors";
import { day as fmtDay, num, usd, count } from "@/lib/format";
import { Segmented } from "./ui/segmented";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

export type Metric = "sandboxHours" | "gibHours" | "sandboxes" | "usd";

export const METRICS: readonly { value: Metric; label: string; unit: string }[] = [
  { value: "sandboxHours", label: "Sandbox-hours", unit: "sandbox-hours" },
  { value: "gibHours", label: "Memory GiB-h", unit: "GiB-hours of memory" },
  { value: "sandboxes", label: "Sandboxes", unit: "sandboxes that ran" },
  { value: "usd", label: "Spend", unit: "USD at list price" },
];

const fmt = (m: Metric, v: number) => (m === "usd" ? usd(v) : m === "sandboxes" ? count(v) : num(v));

/** Every day from `from` to the last day, so quiet days show as gaps on the axis, not missing. */
function daysFrom(from: string, n: number): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

export function UsageChart({ points, from, days }: { points: UsagePoint[]; from: string; days: number }) {
  const [metric, setMetric] = useState<Metric>("sandboxHours");
  const [asTable, setAsTable] = useState(false);

  const weights = useMemo(() => {
    const w = new Map<string, number>();
    for (const p of points) w.set(p.provider, (w.get(p.provider) ?? 0) + p.sandboxHours);
    return w;
  }, [points]);
  const series = useProviderSeries(weights);
  const rows = useMemo(() => {
    const byDay = new Map(daysFrom(from, days).map((d) => [d, { day: d } as Record<string, number | string>]));
    for (const p of points) {
      const row = byDay.get(p.day);
      if (!row) continue;
      const key = series.fold(p.provider);
      row[key] = ((row[key] as number | undefined) ?? 0) + (p[metric] ?? 0);
    }
    return [...byDay.values()];
  }, [points, from, days, metric, series]);

  const unit = METRICS.find((m) => m.value === metric)!.unit;
  const top = series.keys.at(-1);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Measure" value={metric} onChange={setMetric} options={METRICS} />
        <Segmented
          label="Show as"
          value={asTable ? "table" : "chart"}
          onChange={(v) => setAsTable(v === "table")}
          options={[
            { value: "chart", label: "Chart" },
            { value: "table", label: "Table" },
          ]}
        />
      </div>
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Providers">
        {series.keys.map((k) => (
          <li key={k} className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <span className="size-2.5 rounded-[3px]" style={{ background: series.color(k) }} aria-hidden />
            {k}
          </li>
        ))}
      </ul>
      {asTable ? (
        <div className="max-h-[320px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day (UTC)</TableHead>
                {series.keys.map((k) => (
                  <TableHead key={k} className="text-right">
                    {k}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...rows].reverse().map((r) => (
                <TableRow key={r.day as string}>
                  <TableCell>{fmtDay(r.day as string)}</TableCell>
                  {series.keys.map((k) => (
                    <TableCell key={k} className="text-right">
                      {r[k] === undefined ? <span className="text-faint">—</span> : fmt(metric, r[k] as number)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="h-[280px] w-full" role="img" aria-label={`${unit} per day by provider, last ${days} days`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 4, right: 0, bottom: 0, left: 0 }} barCategoryGap="22%">
              <CartesianGrid vertical={false} stroke="#ecebe7" />
              <XAxis
                dataKey="day"
                tickLine={false}
                axisLine={{ stroke: "#d3d2cc" }}
                tick={{ fontSize: 11.5, fill: "#8a8984" }}
                tickFormatter={(d: string) => fmtDay(d)}
                interval="preserveStartEnd"
                minTickGap={28}
              />
              <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11.5, fill: "#8a8984" }} width={52} tickFormatter={(v: number) => fmt(metric, v)} />
              <Tooltip cursor={{ fill: "rgba(11,11,11,0.04)" }} content={(props) => <ChartTip {...props} metric={metric} color={series.color} />} />
              {series.keys.map((k) => (
                <Bar key={k} dataKey={k} stackId="a" fill={series.color(k)} stroke="#ffffff" strokeWidth={1} radius={k === top ? [3, 3, 0, 0] : 0} isAnimationActive={false} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="mt-2 text-[12px] text-faint">Days in UTC. {metric === "usd" ? "Spend at the providers' list prices with every vCPU busy: an upper bound, as the router meters it." : `In ${unit}.`}</p>
    </div>
  );
}

function ChartTip({ active, payload, label, metric, color }: TooltipContentProps<TooltipValueType, string | number> & { metric: Metric; color: (k: string) => string }) {
  if (!active || !payload?.length) return null;
  const items = payload.filter((p) => typeof p.value === "number" && p.value > 0).sort((a, b) => (b.value as number) - (a.value as number));
  const total = items.reduce((s, p) => s + (p.value as number), 0);
  return (
    <div className="min-w-[180px] rounded-lg border bg-background px-3 py-2.5 text-[12.5px] shadow-[0_6px_24px_rgba(11,11,11,0.10)]">
      <div className="mb-1.5 flex justify-between gap-4 font-medium">
        <span>{fmtDay(String(label))}</span>
        <span className="tabular">{fmt(metric, total)}</span>
      </div>
      {items.length === 0 && <div className="text-muted-foreground">Nothing ran.</div>}
      {items.map((p) => (
        <div key={String(p.dataKey)} className="flex items-center justify-between gap-4 py-0.5">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-2 rounded-[2px]" style={{ background: color(String(p.dataKey)) }} />
            {String(p.dataKey)}
          </span>
          <span className="tabular">{fmt(metric, p.value as number)}</span>
        </div>
      ))}
    </div>
  );
}
