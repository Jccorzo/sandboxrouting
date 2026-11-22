"use client";

import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/utils";

export interface TierRow {
  id: string;
  name: string;
  free: string;
  limitsHtml: string;
  paidHtml: string;
  isolation: string;
  checked: string;
}

export interface TierTab {
  key: string;
  label: string;
  count: number;
  rows: TierRow[];
}

export function TiersClient({ tabs }: { tabs: TierTab[] }) {
  const [active, setActive] = useState(tabs[0]!.key);
  const tab = tabs.find((t) => t.key === active) ?? tabs[0]!;
  return (
    <div className="mt-14 grid gap-6 md:grid-cols-[170px_minmax(0,1fr)] md:gap-10">
      <div role="tablist" aria-label="Kinds of free usage" className="sticky top-0 z-10 -mx-[var(--gutter)] flex gap-[6px] overflow-x-auto bg-ground px-[var(--gutter)] py-2 md:static md:mx-0 md:flex-col md:px-0 md:py-0">
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`tab-${t.key}`}
              aria-selected={on}
              aria-controls={`panel-${t.key}`}
              onClick={() => setActive(t.key)}
              className={cn(
                "flex h-16 min-w-[150px] flex-col justify-center px-4 text-left transition-[background-color,color,transform] duration-200 active:scale-[0.98]",
                on ? "bg-ink text-ground" : "bg-tone-1 text-ink hover:bg-tone-2",
              )}
            >
              <span className="text-[16px] font-medium leading-tight">{t.label}</span>
              <span className={cn("text-[13px] tabular", on ? "text-ground/75" : "text-muted")}>{t.count} providers</span>
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`panel-${tab.key}`} aria-labelledby={`tab-${tab.key}`} className="space-y-[4px]">
        {tab.rows.map((r, i) => (
          <div
            key={r.id}
            className={cn(
              "grid gap-x-6 gap-y-1 p-4 md:min-h-[76px] md:grid-cols-[minmax(150px,22%)_minmax(0,1fr)_minmax(0,28%)] md:items-center md:px-5 md:py-3",
              i % 2 ? "bg-tone-1" : "bg-tone-2/70",
            )}
          >
            <span className="text-[20px] font-medium leading-tight tracking-[-0.01em] tabular">{r.free}</span>
            <div className="min-w-0">
              <Link href={`/providers/${r.id}/`} className="text-[18px] font-medium hover:underline">
                {r.name}
              </Link>
              <p className="text-[13px] leading-snug text-muted [&_code]:text-[13px]" dangerouslySetInnerHTML={{ __html: r.limitsHtml }} />
            </div>
            <div className="text-[14px] leading-snug md:text-right">
              <span className="[&_code]:text-[13px]" dangerouslySetInnerHTML={{ __html: r.paidHtml }} />
              <span className="block text-[13px] text-muted">
                {r.isolation}, checked {r.checked}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
