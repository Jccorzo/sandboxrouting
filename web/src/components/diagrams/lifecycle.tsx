"use client";

import { useEffect, useRef, useState } from "react";
import type { TransitionCell } from "@/lib/generated-types";
import { cn } from "@/lib/utils";

/** Where each state sits. The moves between them come from the router's transition(). */
const NODES: Record<string, { x: number; y: number; derived?: boolean }> = {
  creating: { x: 90, y: 190 },
  running: { x: 330, y: 190 },
  paused: { x: 600, y: 60 },
  expired: { x: 600, y: 190, derived: true },
  stopped: { x: 850, y: 190 },
  failed: { x: 600, y: 330 },
};
const BW = 112;
const BH = 44;

/** Orthogonal routes for each move the router allows (from → to), keyed "from>to". */
const ROUTES: Record<string, { d: string; lx: number; ly: number; anchor?: "start" | "middle" | "end" }> = {
  "creating>running": { d: "M146 190 H274", lx: 210, ly: 182 },
  "creating>failed": { d: "M90 212 V330 H544", lx: 100, ly: 318, anchor: "start" },
  "running>paused": { d: "M318 168 V54 H544", lx: 326, ly: 46, anchor: "start" },
  "paused>running": { d: "M544 72 H346 V168", lx: 430, ly: 88 },
  "running>running": { d: "M300 168 V136 H262 V180 H274", lx: 258, ly: 128, anchor: "end" },
  "running>expired": { d: "M386 190 H544", lx: 465, ly: 182 },
  "running>stopped": { d: "M360 212 V262 H850 V212", lx: 720, ly: 254 },
  "running>failed": { d: "M330 212 V318 H544", lx: 338, ly: 296, anchor: "start" },
  "paused>stopped": { d: "M656 60 H850 V168", lx: 760, ly: 52 },
  "paused>failed": { d: "M630 82 V120 H740 V330 H656", lx: 748, ly: 300, anchor: "start" },
  "expired>stopped": { d: "M656 190 H794", lx: 725, ly: 182 },
  "expired>failed": { d: "M600 212 V308", lx: 608, ly: 288, anchor: "start" },
};

type Edge = { key: string; from: string; to: string; events: string[] };

function edgesOf(cells: TransitionCell[]): Edge[] {
  const map = new Map<string, Edge>();
  for (const c of cells) {
    if (!c.to) continue;
    if (c.to === c.from && c.event !== "timeoutSet") continue; // idempotent repeats are not moves
    const key = `${c.from}>${c.to}`;
    const e = map.get(key) ?? { key, from: c.from, to: c.to, events: [] };
    e.events.push(c.event);
    map.set(key, e);
  }
  return [...map.values()];
}

export function Lifecycle({ cells, events }: { cells: TransitionCell[]; events: string[] }) {
  const edges = edgesOf(cells);
  const [state, setState] = useState("creating");
  const [moving, setMoving] = useState<{ key: string; t: number } | null>(null);
  const [note, setNote] = useState<string>("A new record starts in creating, holding what its timeout can spend");
  const raf = useRef<number | undefined>(undefined);
  const pathRefs = useRef(new Map<string, SVGPathElement>());
  const [token, setToken] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => () => cancelAnimationFrame(raf.current ?? 0), []);

  const cellFor = (ev: string) => cells.find((c) => c.from === state && c.event === ev);
  const deadline = state === "running";

  function go(ev: string) {
    if (moving) return;
    const cell = cellFor(ev);
    if (!cell?.to) return;
    const edgeKey = `${state}>${cell.to}`;
    const path = pathRefs.current.get(edgeKey);
    const done = () => {
      setState(cell.to!);
      setMoving(null);
      setToken(null);
      setNote(`${ev}: ${state} → ${cell.to}${cell.error ? ` (${cell.error})` : ""}`);
    };
    if (!path || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return done();
    const len = path.getTotalLength();
    let start: number | undefined;
    setMoving({ key: edgeKey, t: 0 });
    const tick = (now: number) => {
      start ??= now;
      const t = Math.min(1, (now - start) / 650);
      const eased = 1 - Math.pow(1 - t, 3);
      const pt = path.getPointAtLength(eased * len);
      setToken({ x: pt.x, y: pt.y });
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else done();
    };
    raf.current = requestAnimationFrame(tick);
  }

  function letDeadlinePass() {
    if (!deadline || moving) return;
    setState("expired");
    setNote("The deadline passed. Nothing was written: a running record past its deadline reads as expired");
  }

  return (
    <div data-ui className="bg-tone-1">
      <svg viewBox="0 0 940 380" className="block w-full bg-ground" role="img" aria-label={`Sandbox lifecycle; current state ${state}`}>
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--ink)" />
          </marker>
          <marker id="arrow-g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--green)" />
          </marker>
        </defs>
        {edges.map((e) => {
          const r = ROUTES[e.key];
          if (!r) return null;
          const live = e.from === state;
          const active = moving?.key === e.key;
          return (
            <g key={e.key}>
              <path
                ref={(el) => {
                  if (el) pathRefs.current.set(e.key, el);
                }}
                d={r.d}
                fill="none"
                stroke={active ? "var(--green)" : live ? "var(--ink)" : "var(--tone-3)"}
                strokeWidth={active || live ? 2 : 1.5}
                markerEnd={active ? "url(#arrow-g)" : "url(#arrow)"}
                className="transition-[stroke] duration-300"
              />
              <text x={r.lx} y={r.ly} textAnchor={r.anchor ?? "middle"} className={cn("text-[12px]", live ? "fill-ink font-medium" : "fill-muted")}>
                {e.events.join(" · ")}
              </text>
            </g>
          );
        })}
        <path d={ROUTES["running>expired"]!.d} fill="none" stroke={state === "running" ? "var(--ink)" : "var(--tone-3)"} strokeWidth={1.5} strokeDasharray="5 4" markerEnd="url(#arrow)" />
        <text x={ROUTES["running>expired"]!.lx} y={ROUTES["running>expired"]!.ly} textAnchor="middle" className="fill-muted text-[12px]">
          deadline passes
        </text>
        {Object.entries(NODES).map(([name, n]) => {
          const on = name === state;
          return (
            <g key={name} transform={`translate(${n.x - BW / 2} ${n.y - BH / 2})`}>
              <rect
                width={BW}
                height={BH}
                rx={6}
                fill={on ? (name === "running" ? "var(--green)" : "var(--ink)") : "var(--ground)"}
                stroke="var(--ink)"
                strokeWidth={1.5}
                strokeDasharray={n.derived ? "5 4" : undefined}
                className="transition-[fill] duration-300"
              />
              <text x={BW / 2} y={BH / 2 + 5} textAnchor="middle" className={cn("text-[14px] font-semibold", on && name !== "running" ? "fill-ground" : "fill-ink")}>
                {name}
              </text>
            </g>
          );
        })}
        <text x={600} y={232} textAnchor="middle" className="fill-muted text-[11.5px]">
          derived, never stored
        </text>
        {token ? <circle cx={token.x} cy={token.y} r={7} fill="var(--green)" stroke="var(--ink)" strokeWidth={1.5} /> : null}
      </svg>
      <div className="p-4 sm:p-5">
        <p className="text-[13px] font-semibold">Send an event to the sandbox in {state}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {events.map((ev) => {
            const cell = cellFor(ev);
            const ok = Boolean(cell?.to) && !(cell?.to === state && ev !== "timeoutSet");
            return (
              <button
                key={ev}
                type="button"
                onClick={() => go(ev)}
                disabled={!ok || Boolean(moving)}
                title={ok ? `${state} → ${cell!.to}` : cell?.error ?? "not allowed"}
                className={cn(
                  "h-9 rounded-[5px] px-3 text-[12.5px] transition-[background-color,transform] active:scale-[0.97]",
                  ok ? "bg-ink text-ground hover:bg-[#2b2b29]" : "bg-tone-2 text-muted",
                )}
              >
                <code>{ev}</code>
              </button>
            );
          })}
          <button
            type="button"
            onClick={letDeadlinePass}
            disabled={!deadline || Boolean(moving)}
            className="h-9 rounded-[5px] bg-ground px-3 text-[12.5px] font-medium transition-[background-color,transform] enabled:hover:bg-tone-2 active:scale-[0.97] disabled:text-muted"
          >
            let the deadline pass
          </button>
          <button type="button" onClick={() => { setState("creating"); setNote("Back to a new record in creating"); }} className="h-9 rounded-[5px] px-3 text-[12.5px] font-medium text-muted hover:text-ink">
            start over
          </button>
        </div>
        <p className="mt-3 min-h-[2.8em] text-[13px] text-muted" aria-live="polite">
          {note}. Disabled events are the ones the router refuses from here; hover one for the error it throws.
        </p>
      </div>
    </div>
  );
}
