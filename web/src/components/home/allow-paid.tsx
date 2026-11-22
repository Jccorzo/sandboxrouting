"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The one switch the whole product turns on, at poster size. Operating it changes the field,
 * one word of the heading, and the count of providers the router would rank: both counts are the
 * router's own plans for the default request (generated), not estimates.
 */
export function AllowPaidField({ free, paid, total }: { free: number; paid: number; total: number }) {
  const [on, setOn] = useState(false);
  return (
    <section
      className={cn(
        "relative mt-[var(--section)] min-h-[86svh] overflow-hidden transition-colors duration-500 sm:min-h-[92svh]",
        on ? "bg-ink text-ground" : "bg-green text-ink",
      )}
      aria-label="Paid usage"
    >
      <div className="wrap relative z-10 pt-16 sm:pt-20">
        <h2 className="text-[clamp(1.75rem,2.6vw,2.5rem)] tracking-[-0.03em]">{on ? "Paid when you say" : "Free until you say"}</h2>
        <p className="mt-4 max-w-[46ch] text-[17px] leading-relaxed">
          {on ? (
            <>
              With <code className="text-[15px]">allowPaid: true</code>, {paid} of {total} providers can take a default request. The free ones still
              go first; paid ones follow, cheapest first, and <code className="text-[15px]">maxPaidUsdPerMonth</code> makes the month&rsquo;s spend a
              hard cap.
            </>
          ) : (
            <>
              With <code className="text-[15px]">allowPaid: false</code>, the default, {free} of {total} providers can take a default request and
              none of them bills you. A request no free tier can take fails, with every provider&rsquo;s reason.
            </>
          )}
        </p>
      </div>
      <div className="absolute bottom-[-3vh] left-[var(--gutter)] text-[40vw] sm:bottom-[7vh] sm:left-auto sm:right-[-2.5vw] sm:text-[clamp(110px,14.5vw,230px)]">
        <div data-ui style={{ fontSize: "inherit" }} className="flex flex-col items-start gap-[0.12em]">
          <span className={cn("text-[0.32em] font-medium tracking-[-0.02em]", on ? "text-ground/80" : "text-ink/80")}>
            allowPaid: <span className="tabular">{on ? "true" : "false"}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Allow paid usage"
            onClick={() => setOn((v) => !v)}
            className={cn(
              "relative h-[1em] w-[1.9em] rounded-full transition-[background-color,transform] duration-500 active:scale-[0.99]",
              on ? "bg-ground" : "bg-ink",
            )}
          >
            <span
              className={cn(
                "absolute left-[0.09em] top-[0.09em] block size-[0.82em] rounded-full transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]",
                on ? "translate-x-[0.9em] bg-ink" : "translate-x-0 bg-green",
              )}
            />
          </button>
        </div>
      </div>
    </section>
  );
}
