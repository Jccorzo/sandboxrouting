"use client";

import { useState } from "react";
import { lapse } from "@/lib/format";
import type { CircuitPoint } from "@/lib/generated-types";
import { cn } from "@/lib/utils";

const STATE_FILL: Record<string, string> = { closed: "var(--green)", open: "var(--ink)", "half-open": "var(--tone-3)" };
const STATE_TEXT: Record<string, string> = {
  closed: "Closed: creates go to the provider.",
  open: "Open: the provider is skipped until the cooldown ends.",
  "half-open": "Half-open: one create may probe it; a second waits while that probe is in flight.",
};

/**
 * The circuit breaker on one provider, from a run of the real router: Northflank fails with 503s,
 * Modal takes what it drops. Health is derived from the ledger's samples on every read; nothing
 * stores "open".
 */
export function Circuit({ points, cfg }: { points: CircuitPoint[]; cfg: { failures: number; cooldownSec: number; maxCooldownSec: number } }) {
  const [sel, setSel] = useState(2);
  const end = points.at(-1)!.atSec + 40;
  const W = 960;
  // Events are evenly spaced (some are seconds apart, some minutes); time runs piecewise between them.
  const step = (W - 120) / points.length;
  const x = (t: number) => {
    const n = points.findIndex((p, k) => t >= p.atSec && t <= (points[k + 1]?.atSec ?? end));
    if (n === -1) return 40;
    const a = points[n]!.atSec;
    const b = points[n + 1]?.atSec ?? end;
    return 40 + (n + (b === a ? 0 : (t - a) / (b - a))) * step;
  };
  const p = points[sel]!;

  // The band: each point's state holds until the next point (or its openUntil, when it lapses first).
  const segments: { from: number; to: number; state: string }[] = [];
  points.forEach((pt, n) => {
    const next = points[n + 1]?.atSec ?? end;
    if (pt.circuit === "open" && pt.openUntilSec !== undefined && pt.openUntilSec < next) {
      segments.push({ from: pt.atSec, to: pt.openUntilSec, state: "open" });
      segments.push({ from: pt.openUntilSec, to: next, state: "half-open" });
    } else segments.push({ from: pt.atSec, to: next, state: pt.circuit });
  });

  return (
    <div data-ui className="bg-tone-1">
      <div className="overflow-x-auto bg-ground">
      <svg viewBox={`0 0 ${W} 150`} className="block w-full min-w-[640px] bg-ground" role="img" aria-label="Circuit state of the provider over time">
        {segments.map((s, n) => (
          <rect key={n} x={x(s.from)} y={58} width={Math.max(0, x(s.to) - x(s.from))} height={14} fill={STATE_FILL[s.state]} />
        ))}
        {points.map((pt, n) => {
          const failed = pt.event.includes("failed");
          const created = pt.event.includes("created");
          const skipped = pt.event.includes("skipped");
          const request = failed || created || skipped;
          return (
            <g key={n} transform={`translate(${x(pt.atSec)} 0)`}>
              <line y1={44} y2={86} stroke="var(--ink)" strokeWidth={n === sel ? 2 : 1} />
              <circle
                cy={36}
                r={request ? 9 : 5}
                fill={created ? "var(--green)" : failed ? "var(--ink)" : "var(--ground)"}
                stroke="var(--ink)"
                strokeWidth={1.5}
              />
              <text y={110} textAnchor="middle" className={cn("text-[13px] tabular-nums", n === sel ? "fill-ink font-semibold" : "fill-muted")}>
                {pt.atSec}s
              </text>
              <rect x={-16} y={20} width={32} height={100} fill="transparent" className="cursor-pointer" onClick={() => setSel(n)}>
                <title>{pt.event}</title>
              </rect>
            </g>
          );
        })}
        <text x={40} y={142} className="fill-muted text-[13px]">
          green closed, black open, grey half-open; filled dots are creates that failed (black) or worked (green)
        </text>
      </svg>
      </div>
      <div className="grid gap-4 p-4 sm:grid-cols-[1fr_auto] sm:items-center sm:p-5">
        <div aria-live="polite">
          <p className="text-[14px] font-semibold">
            t = {p.atSec} s. {p.event}
          </p>
          <p className="mt-1 text-[13px] text-muted">
            {STATE_TEXT[p.circuit]} {p.consecutiveFailures} failure{p.consecutiveFailures === 1 ? "" : "s"} in a row
            {p.openUntilSec !== undefined ? `; open for ${lapse(p.openUntilSec - p.atSec)} more` : ""}.
          </p>
        </div>
        <div className="flex gap-1">
          <button type="button" onClick={() => setSel((s) => Math.max(0, s - 1))} disabled={sel === 0} className="h-9 rounded-[5px] bg-ground px-3 text-[13px] font-medium disabled:opacity-40">
            Earlier
          </button>
          <button type="button" onClick={() => setSel((s) => Math.min(points.length - 1, s + 1))} disabled={sel === points.length - 1} className="h-9 rounded-[5px] bg-ink px-3 text-[13px] font-medium text-ground disabled:opacity-40">
            Later
          </button>
        </div>
      </div>
      <p className="px-4 pb-4 text-[13px] text-muted sm:px-5">
        Config: {cfg.failures} failures open it for {cfg.cooldownSec} s, doubling with each further failure up to {cfg.maxCooldownSec} s (routing.circuitBreaker).
      </p>
    </div>
  );
}
