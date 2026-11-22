"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FILTERS, LANE_LABEL, isFreeLane } from "@/lib/format";
import type { PlanDoc } from "@/lib/generated-types";
import { cn } from "@/lib/utils";
import { PlanControls } from "./plan-controls";
import { shownPlan, usePlan, type Controls } from "./use-plan";

const W = 1000;
const LANES = ["self-hosted-first", "free-recurring", "free-one-time", "self-hosted", "paid"];
const GATE_X0 = 196;
const GATE_DX = 36;
const LANE_X0 = 660;
const LANE_DX = 18;
const PER_LINE = 18;

interface Pos {
  x: number;
  y: number;
  fill: string;
  stroke: string;
  title: string;
}

/**
 * Every provider is a dot. A request sends each one through the hard rules: the ones a rule
 * leaves out stop under it, the rest land in their lane in the order the strategy gave. The
 * plan is the router's own, generated at build time.
 */
function layout(plan: PlanDoc, ids: string[], names: Record<string, string>): { pos: Map<string, Pos>; height: number; lanes: { lane: string; y: number; n: number }[]; first?: string } {
  const pos = new Map<string, Pos>();
  const gateCount = new Array(13).fill(0) as number[];
  for (const s of plan.skipped) {
    const g = s.filter === 0 ? 12 : s.filter;
    const k = gateCount[g]!++;
    pos.set(s.provider, { x: GATE_X0 + (g - 1) * GATE_DX + (k % 3) * 9 - 9, y: 150 + Math.floor(k / 3) * 9, fill: "var(--tone-3)", stroke: "none", title: `${names[s.provider] ?? s.provider}: ${s.reason}` });
  }
  const lanes: { lane: string; y: number; n: number }[] = [];
  let y = 64;
  for (const lane of LANES) {
    const entries = plan.ordered.filter((e) => e.lane === lane);
    if (!entries.length) continue;
    lanes.push({ lane, y, n: entries.length });
    entries.forEach((e, i) => {
      const rank = plan.ordered.indexOf(e) + 1;
      const free = isFreeLane(e.lane);
      const self = e.lane.startsWith("self");
      pos.set(e.provider, {
        x: LANE_X0 + (i % PER_LINE) * LANE_DX,
        y: y + 22 + Math.floor(i / PER_LINE) * 16,
        fill: free ? "var(--green)" : self ? "var(--ground)" : "var(--ink)",
        stroke: self ? "var(--ink)" : "none",
        title: `${rank}. ${names[e.provider] ?? e.provider}: ${[LANE_LABEL[e.lane] ?? e.lane, ...e.why.slice(1)].join(", ")}`,
      });
    });
    y += 22 + Math.ceil(entries.length / PER_LINE) * 16 + 22;
  }
  const gateDepth = 150 + Math.ceil(Math.max(...gateCount) / 3) * 9 + 20;
  // Any provider the plan doesn't mention stays where it started (it can't happen, but never hide one).
  ids.forEach((id, i) => {
    if (!pos.has(id)) pos.set(id, { x: 24 + (i % 9) * 13, y: 64 + Math.floor(i / 9) * 13, fill: "var(--ink)", stroke: "none", title: id });
  });
  return { pos, height: Math.max(y, gateDepth, 64 + Math.ceil(ids.length / 9) * 13 + 30), lanes, first: plan.ordered[0]?.provider };
}

export function RouteField({ initial, defaults, options, names }: { initial: { key: string; plan: PlanDoc }; defaults: Controls; options: { strategies: string[]; needs: string[]; isolation: string[] }; names: Record<string, string> }) {
  const [controls, setControls] = useState(defaults);
  const [state, retry] = usePlan(controls, initial);
  const plan = shownPlan(state);
  const ids = useMemo(() => Object.keys(names), [names]);
  const target = useMemo(() => layout(plan, ids, names), [plan, ids, names]);
  const ref = useRef<SVGSVGElement>(null);
  // Dots start in the source grid and leave it once the field is on screen.
  const [routed, setRouted] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
      const t = setTimeout(() => setRouted(true), 0);
      return () => clearTimeout(t);
    }
    const io = new IntersectionObserver(([e]) => {
      if (e?.isIntersecting) {
        setTimeout(() => setRouted(true), 250);
        io.disconnect();
      }
    }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const firstPos = target.first ? target.pos.get(target.first) : undefined;

  return (
    <div data-ui className="bg-tone-1">
      <PlanControls controls={controls} onChange={setControls} options={options} className="px-5 pb-5 pt-5" />
      {state.status === "error" ? (
        <div role="alert" className="mx-5 mb-3 flex items-center justify-between gap-3 bg-tone-2 px-3 py-2 text-[13px]">
          <span>Couldn&rsquo;t load this plan ({state.message}). Showing the previous one.</span>
          <button type="button" onClick={retry} className="rounded-[5px] bg-ink px-2.5 py-1 font-medium text-ground">
            Retry
          </button>
        </div>
      ) : null}
      <svg ref={ref} viewBox={`0 0 ${W} ${target.height}`} className={cn("block w-full bg-ground transition-opacity", state.status === "loading" && "opacity-60")} role="img" aria-label={`${plan.skipped.length} providers left out by the hard rules, ${plan.ordered.length} ranked by ${plan.strategy}${target.first ? `; ${names[target.first]} is asked first` : ""}`}>
        <text x={20} y={34} className="fill-ink text-[13px] font-semibold">{ids.length} providers</text>
        <text x={GATE_X0 - 14} y={34} className="fill-ink text-[13px] font-semibold">The hard rules, the same for every strategy</text>
        <text x={LANE_X0 - 4} y={34} className="fill-ink text-[13px] font-semibold">Lanes, in the order {plan.strategy} gives</text>
        {FILTERS.map((f, i) => {
          const x = GATE_X0 + i * GATE_DX;
          const n = plan.skipped.filter((s) => (s.filter === 0 ? 12 : s.filter) === f.n).length;
          return (
            <g key={f.n}>
              <title>{`${f.name}: ${n} left out`}</title>
              <rect x={x - 15} y={50} width={30} height={target.height - 62} fill={n ? "var(--tone-1)" : "transparent"} />
              <text transform={`translate(${x + 4} ${118}) rotate(-90)`} className={cn("text-[11.5px]", n ? "fill-ink" : "fill-muted")}>
                {f.short}
              </text>
              <text x={x} y={138} textAnchor="middle" className={cn("text-[12px] font-semibold tabular-nums", n ? "fill-ink" : "fill-tone-3")}>
                {n}
              </text>
            </g>
          );
        })}
        {target.lanes.map((l) => (
          <text key={l.lane} x={LANE_X0 - 4} y={l.y + 6} className="fill-muted text-[12px]">
            {LANE_LABEL[l.lane] ?? l.lane} <tspan className="fill-ink font-semibold">{l.n}</tspan>
          </text>
        ))}
        {ids.map((id, i) => {
          const p = target.pos.get(id)!;
          const x = routed ? p.x : 24 + (i % 9) * 13;
          const y = routed ? p.y : 64 + Math.floor(i / 9) * 13;
          return (
            <circle
              key={id}
              r={4}
              cx={0}
              cy={0}
              style={{
                transform: `translate(${x}px, ${y}px)`,
                transition: `transform 1000ms var(--ease-out) ${(i % 27) * 12}ms, fill 400ms ease`,
              }}
              fill={routed ? p.fill : "var(--ink)"}
              stroke={routed ? p.stroke : "none"}
              strokeWidth={1.5}
            >
              <title>{p.title}</title>
            </circle>
          );
        })}
        {routed && firstPos ? (
          <g style={{ transform: `translate(${firstPos.x}px, ${firstPos.y}px)`, transition: "transform 1000ms var(--ease-out)" }}>
            <circle r={9} fill="none" stroke="var(--green)" strokeWidth={2} />
          </g>
        ) : null}
      </svg>
      <p className="px-5 py-3 text-[13px] text-muted">
        {target.first ? (
          <>
            Asked first: <span className="font-semibold text-ink">{names[target.first]}</span>. If it refuses, the next dot in its lane is tried, then the next lane. Hover a dot for its reason.
          </>
        ) : (
          <>No provider can take this request; the router fails it with every reason. Hover a dot for its reason.</>
        )}
      </p>
    </div>
  );
}
