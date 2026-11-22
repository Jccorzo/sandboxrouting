"use client";

import { useEffect, useRef, useState } from "react";
import { Glyph } from "@/components/site/glyph";
import type { JobFrame } from "@/lib/generated-types";
import { cn } from "@/lib/utils";

const STRIP = ["queued", "placing", "preparing", "running", "migrating", "succeeded"];

/**
 * A job losing its box mid-step and finishing on another, frame by frame. Every frame is the
 * record transitionJob() returned for that event at build time; a move it refused would have
 * failed the build.
 */
export function JobMove({ frames, steps }: { frames: JobFrame[]; steps: string[] }) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const f = frames[i]!;

  useEffect(() => {
    if (!playing) return;
    if (i >= frames.length - 1) {
      timer.current = setTimeout(() => setPlaying(false), 0);
      return () => clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => setI((n) => n + 1), 1100);
    return () => clearTimeout(timer.current);
  }, [playing, i, frames.length]);

  const boxes = [...new Set(frames.flatMap((x) => x.placements.map((p) => p.provider)))];
  const upto = frames.slice(0, i + 1);
  const checkpoints = [...new Set(upto.filter((x) => x.event === "stepSucceeded" && x.checkpoint !== undefined).map((x) => x.checkpoint!))];
  const placementOf = (provider: string) => f.placements.find((p) => p.provider === provider);
  const restored = f.event === "prepared" && f.cursor > 0;
  const stored = f.event === "stepSucceeded" && f.checkpoint !== undefined;

  const stepStatus = (n: number): "done" | "running" | "lost" | "pending" => {
    if (f.inFlight === n) return "running";
    if (n < f.cursor) return "done";
    if (f.state === "migrating" && n === f.cursor) return "lost";
    return "pending";
  };

  return (
    <div data-ui className="bg-tone-1">
      <ol className="flex flex-wrap gap-[3px] p-1.5" aria-label="Job state">
        {STRIP.map((s) => (
          <li
            key={s}
            className={cn(
              "flex-1 rounded-[4px] px-2 py-2 text-center text-[12.5px] font-medium transition-colors duration-300",
              f.state === s ? (s === "succeeded" ? "bg-green text-ink" : s === "migrating" ? "bg-ink text-ground" : "bg-ink text-ground") : "bg-ground text-muted",
            )}
          >
            {s}
          </li>
        ))}
      </ol>
      <div className="grid gap-[3px] px-1.5 sm:grid-cols-[1fr_0.8fr_1fr]">
        {[boxes[0], "store", boxes[1]].map((col, n) => {
          if (col === "store") {
            return (
              <div key="store" className={cn("flex flex-col justify-between bg-ground p-4 transition-colors", (stored || restored) && "bg-green-wash")}>
                <div>
                  <p className="text-[13px] font-semibold">Checkpoints</p>
                  <code className="text-[11.5px] text-muted">~/.sandboxrouting/checkpoints/</code>
                </div>
                <ul className="mt-3 space-y-1 text-[12.5px]">
                  {checkpoints.length ? (
                    checkpoints.map((c) => (
                      <li key={c} className="flex items-center gap-1.5">
                        <span className="text-green-ink">
                          <Glyph kind="ok" />
                        </span>
                        workdir after step {c}, SHA-256 checked
                      </li>
                    ))
                  ) : (
                    <li className="text-muted">none yet: the initial files are the spec&rsquo;s</li>
                  )}
                </ul>
                <p className="mt-3 text-[12px] text-muted" aria-live="polite">
                  {stored ? `stored step ${f.checkpoint} ←` : restored ? `→ restored step ${f.cursor - 1}` : " "}
                </p>
              </div>
            );
          }
          const p = col ? placementOf(col) : undefined;
          const here = f.box?.provider === col;
          const lost = p?.endReason === "lost" || (here && f.state === "migrating");
          const finished = p?.endReason === "finished";
          return (
            <div key={col ?? n} className={cn("min-h-[150px] p-4 transition-colors duration-300", here ? (f.state === "migrating" ? "bg-tone-2" : "bg-ground") : finished ? "bg-green-wash" : "bg-ground/60")}>
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[13px] font-semibold">
                  Box {n === 0 ? 1 : 2}: {col}
                </p>
                <span className={cn("text-[12px] font-medium", finished ? "text-green-ink" : "text-ink")}>
                  {p ? (p.endReason ?? (here ? f.state : "")) : "not placed yet"}
                </span>
              </div>
              <div className="mt-4 flex h-[64px] items-center justify-center">
                {lost ? (
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    <Glyph kind="fail" className="size-5" /> gone before its deadline
                  </span>
                ) : here && f.inFlight !== undefined ? (
                  <code className="max-w-full truncate rounded-[4px] bg-tone-1 px-2 py-1 text-[12px] motion-safe:animate-pulse">{steps[f.inFlight]}</code>
                ) : here ? (
                  <span className="text-[13px] text-muted">{f.state === "preparing" ? "setup, then restore" : f.state}</span>
                ) : finished ? (
                  <span className="flex items-center gap-2 text-[13px] font-medium text-green-ink">
                    <Glyph kind="ok" className="size-5" /> finished, killed
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <ol className="mt-[3px] space-y-[3px] px-1.5" aria-label="Steps">
        {steps.map((s, n) => {
          const st = stepStatus(n);
          return (
            <li key={s} className={cn("flex items-center gap-3 px-4 py-2 text-[12.5px] transition-colors", st === "done" ? "bg-green-wash" : st === "running" ? "bg-ground" : "bg-ground/60")}>
              <span className={cn("w-4", st === "done" ? "text-green-ink" : "text-ink")}>
                {st === "done" ? <Glyph kind="ok" /> : st === "lost" ? <Glyph kind="fail" /> : st === "running" ? <span className="block size-2 rounded-full bg-ink motion-safe:animate-pulse" /> : null}
              </span>
              <code className="min-w-0 flex-1 truncate">{s}</code>
              <span className="shrink-0 text-muted">{n === steps.length - 1 ? "idempotent: false" : "idempotent"}</span>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-3 p-4 sm:p-5">
        <div className="flex gap-1">
          <button type="button" onClick={() => { setPlaying(false); setI((n) => Math.max(0, n - 1)); }} disabled={i === 0} className="h-9 rounded-[5px] bg-ground px-3 text-[13px] font-medium disabled:opacity-40">
            Back
          </button>
          <button
            type="button"
            onClick={() => {
              if (i >= frames.length - 1) setI(0);
              setPlaying((p) => !p);
            }}
            className="h-9 min-w-[72px] rounded-[5px] bg-ink px-3 text-[13px] font-medium text-ground"
          >
            {playing ? "Pause" : i >= frames.length - 1 ? "Replay" : "Play"}
          </button>
          <button type="button" onClick={() => { setPlaying(false); setI((n) => Math.min(frames.length - 1, n + 1)); }} disabled={i === frames.length - 1} className="h-9 rounded-[5px] bg-ground px-3 text-[13px] font-medium disabled:opacity-40">
            Next
          </button>
        </div>
        <input
          type="range"
          min={0}
          max={frames.length - 1}
          value={i}
          onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }}
          aria-label="Event"
          className="h-9 min-w-[160px] flex-1 accent-[var(--green)]"
        />
        <p className="w-full text-[13px]" aria-live="polite">
          <code className="font-semibold">{f.event}</code>
          {f.detail ? <span className="text-muted">: {f.detail}</span> : null}
          <span className="text-muted">
            {" "}
            ({i + 1} of {frames.length}, {f.migrations} migration{f.migrations === 1 ? "" : "s"})
          </span>
        </p>
      </div>
    </div>
  );
}
