"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

type Ranked = { id: string; name: string; free: boolean };

/**
 * The one switch the whole product turns on. Operating it changes the field, one word of the
 * heading, the count, and which names in the ranking are live. The ranking is the router's own plan
 * for the default request with paid usage on (generated), free providers first; with the switch off
 * the paid ones are struck out, because the router would not rank them.
 */
export function AllowPaidField({ free, paid, total, order }: { free: number; paid: number; total: number; order: Ranked[] }) {
  const [on, setOn] = useState(false);
  return (
    <section
      className={cn(
        "mt-[var(--section)] py-[clamp(64px,9vw,144px)] transition-colors duration-500",
        on ? "bg-ink text-ground" : "bg-green text-ink",
      )}
      aria-label="Paid usage"
    >
      <div className="wrap grid gap-x-[clamp(32px,5vw,96px)] gap-y-12 lg:grid-cols-12">
        <div className="lg:sticky lg:top-24 lg:col-span-5 lg:self-start">
          <h2 data-reveal className="text-[clamp(2.25rem,4vw,3.75rem)] leading-[1] tracking-[-0.035em]">
            {on ? "Paid when you say" : "Free until you say"}
          </h2>
          <p data-reveal className="mt-6 max-w-[44ch] text-[17px] leading-relaxed">
            {on ? (
              <>
                With <code className="text-[15px]">allowPaid: true</code>, paid providers join the ranking after every free one, cheapest first, and{" "}
                <code className="text-[15px]">maxPaidUsdPerMonth</code> makes the month&rsquo;s spend a hard cap.
              </>
            ) : (
              <>
                <code className="text-[15px]">allowPaid: false</code> is the default: only providers that won&rsquo;t bill you are ranked. A request no
                free tier can take fails, with every provider&rsquo;s reason.
              </>
            )}
          </p>
          <div data-reveal className="mt-10 flex items-center gap-5">
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label="Allow paid usage"
              onClick={() => setOn((v) => !v)}
              className={cn(
                "relative h-14 w-[104px] shrink-0 rounded-full transition-[background-color,transform] duration-500 active:scale-[0.97]",
                "focus-visible:outline-2 focus-visible:outline-offset-4",
                on ? "bg-ground focus-visible:outline-ground" : "bg-ink focus-visible:outline-ink",
              )}
            >
              <span
                className={cn(
                  "absolute left-[6px] top-[6px] block size-11 rounded-full transition-transform duration-500 ease-[var(--ease-out)]",
                  on ? "translate-x-[48px] bg-green" : "translate-x-0 bg-green",
                )}
              />
            </button>
            <code className="text-[clamp(1.25rem,1.6vw,1.5rem)] font-medium">
              allowPaid: <span className="tabular">{on ? "true" : "false"}</span>
            </code>
          </div>
        </div>

        <div className="lg:col-span-7">
          <p data-reveal className="flex flex-wrap items-baseline gap-x-5" aria-live="polite">
            <span className="tabular text-[clamp(5rem,11vw,10rem)] font-medium leading-[0.85] tracking-[-0.05em]">{on ? paid : free}</span>
            <span className="max-w-[18ch] text-[clamp(1.25rem,1.6vw,1.5rem)] leading-snug">
              of {total} providers take the default request
            </span>
          </p>
          <ol data-reveal className="mt-10 flex flex-wrap gap-x-4 gap-y-1.5 text-[15px] leading-snug" aria-label="The router's ranking for the default request">
            {order.map((p) => (
              <li
                key={p.id}
                className={cn(
                  "transition-[color,opacity] duration-500",
                  p.free ? "" : on ? "text-green" : "line-through decoration-1 opacity-40",
                )}
              >
                {p.name}
                {!p.free && !on ? <span className="sr-only"> (not ranked: paid)</span> : null}
              </li>
            ))}
          </ol>
          <p data-reveal className={cn("mt-8 max-w-[60ch] text-[15px] leading-relaxed", on ? "text-ground/75" : "text-ink/75")}>
            The router&rsquo;s own ranking for the example ledger at the top of the page, generated at build time. Providers it skips for other
            reasons (an open circuit, a refused key, a rate limit, macOS only) are left out of both counts.
          </p>
        </div>
      </div>
    </section>
  );
}
