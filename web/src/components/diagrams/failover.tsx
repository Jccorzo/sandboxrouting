"use client";

import { useState } from "react";
import { Glyph } from "@/components/site/glyph";
import { lapse } from "@/lib/format";
import type { FailoverStep } from "@/lib/generated-types";
import { cn } from "@/lib/utils";

const MARK: Record<string, string> = { quota: "quota mark", rate_limit: "rate-limit mark", auth: "auth mark" };
const WHY: Record<string, string> = {
  quota: "Free usage can't take requests until the tier's monthly reset. Then one free create checks whether it is back.",
  rate_limit: "A 429 is nearly always a cap on how many run at once, so the provider is only cooled down.",
  auth: "The key was refused. sbr reset clears the mark once the key is fixed.",
};

/**
 * Three requests through the real router, a few seconds apart. Each row is one attempt from
 * `sandbox.route`; the marks are read back from the ledger after each request.
 */
export function Failover({ steps }: { steps: FailoverStep[] }) {
  const [i, setI] = useState(0);
  const step = steps[i]!;
  return (
    <div data-ui className="bg-tone-1">
      <div role="tablist" aria-label="Requests" className="flex flex-wrap gap-1 bg-tone-2 p-1.5">
        {steps.map((s, n) => (
          <button
            key={s.atSec}
            type="button"
            role="tab"
            aria-selected={n === i}
            onClick={() => setI(n)}
            className={cn(
              "flex min-w-[150px] flex-1 flex-col items-start rounded-[5px] px-3 py-2 text-left transition-colors",
              n === i ? "bg-ground text-ink" : "text-ink hover:bg-tone-1",
            )}
          >
            <span className="text-[13px] text-muted tabular">t = {s.atSec} s</span>
            <span className="text-[13.5px] font-medium leading-snug">{s.label}</span>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-[3px] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="min-w-0 bg-ground p-4 sm:p-5">
          <code className="block truncate text-[13px] text-muted">{step.request}</code>
          <ol key={i} className="mt-4 space-y-2" aria-label="Attempts, in order">
            {step.attempts.map((a, n) => (
              <li
                key={a.provider}
                className={cn(
                  "grid grid-cols-[20px_88px_minmax(0,1fr)] items-start gap-x-2 rounded-[5px] px-3 py-2.5 text-[13px] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-left-2 fill-mode-both",
                  a.outcome === "created" ? "bg-green-wash" : a.outcome === "failed" ? "bg-tone-1" : "bg-ground outline outline-1 outline-tone-2",
                )}
                style={{ animationDelay: `${n * 380}ms`, animationDuration: "420ms" }}
              >
                <span className={cn("pt-0.5", a.outcome === "created" ? "text-green-ink" : a.outcome === "failed" ? "text-ink" : "text-muted")}>
                  <Glyph kind={a.outcome === "created" ? "ok" : a.outcome === "failed" ? "fail" : "skip"} />
                </span>
                <span className="font-semibold">{a.provider}</span>
                <span className="min-w-0">
                  {a.outcome === "created" ? (
                    <span className="text-green-ink">created on a free tier ({a.lane})</span>
                  ) : a.outcome === "failed" ? (
                    <>
                      <span className="font-medium">{a.detail}</span>
                      <span className="block text-muted">
                        refused ({a.kind}), so it gets {a.kind === "auth" ? "an" : "a"} {MARK[a.kind ?? ""] ?? "mark"}
                        {a.untilSec ? ` for ${lapse(a.untilSec)}` : ""}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="text-muted">skipped, not asked: </span>
                      {a.detail}
                      {a.untilSec ? <span className="block text-muted">lapses in {lapse(a.untilSec)}</span> : null}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <div className="min-w-0 bg-ground p-4 sm:p-5">
          <p className="text-[13px] font-semibold">The ledger after this request</p>
          {step.marks.length ? (
            <ul className="mt-3 space-y-3">
              {step.marks.map((m) => (
                <li key={m.provider + m.kind} className="text-[13px]">
                  <span className="font-medium">{m.provider}</span>: {MARK[m.kind] ?? m.kind}, in force for {lapse(m.untilSec - step.atSec)}
                  <span className="block text-muted">{WHY[m.kind]}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13px] text-muted">No marks in force.</p>
          )}
          <p className="mt-5 text-[13px] leading-relaxed text-muted">
            A mark is in force until its time, evaluated whenever it is read. Nothing has to clear it; a free create that works after a quota mark lapses removes it.
          </p>
        </div>
      </div>
    </div>
  );
}
