"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

export interface PanelPart {
  key: string;
  note: { name: string; text: string };
  rows: { label: string; value: string; code?: boolean }[];
}

/** An adapter's declaration, shown whole like a plate in a manual, with a note on each part. */
export function AdapterPanelClient({ title, file, parts }: { title: string; file: string; parts: PanelPart[] }) {
  const [active, setActive] = useState<string | null>(null);
  const left = parts.slice(0, 3);
  const right = parts.slice(3);

  const Note = ({ p, align }: { p: PanelPart; align: "left" | "right" }) => (
    <button
      type="button"
      onMouseEnter={() => setActive(p.key)}
      onMouseLeave={() => setActive(null)}
      onFocus={() => setActive(p.key)}
      onBlur={() => setActive(null)}
      onClick={() => setActive((v) => (v === p.key ? null : p.key))}
      aria-pressed={active === p.key}
      className={cn("block max-w-[30ch] py-2 text-left transition-colors", align === "right" && "lg:ml-auto lg:text-right")}
    >
      <span className={cn("block text-[18px] font-medium", active === p.key && "text-green-ink")}>{p.note.name}</span>
      <span className="mt-1 block text-[15px] leading-snug text-muted">{p.note.text}</span>
    </button>
  );

  return (
    <div className="mt-12 grid gap-8 lg:grid-cols-[1fr_400px_1fr] lg:gap-12">
      <div className="order-2 flex flex-col justify-around gap-4 lg:order-none">
        {left.map((p) => (
          <Note key={p.key} p={p} align="right" />
        ))}
      </div>
      <div data-ui className="order-1 bg-tone-1 lg:order-none">
        <div className="flex items-baseline justify-between bg-tone-2 px-4 py-2.5">
          <span className="text-[14px] font-semibold">{title}</span>
          <code className="text-[12px] text-muted">{file}</code>
        </div>
        <div className="divide-y divide-tone-2">
          {parts.map((p) => (
            <dl key={p.key} className={cn("px-4 py-3 transition-colors duration-200", active === p.key ? "bg-green-wash" : "bg-transparent")}>
              {p.rows.map((r) => (
                <div key={r.label} className="grid grid-cols-[112px_minmax(0,1fr)] gap-2 py-0.5 text-[13px]">
                  <dt className="text-muted">{r.label}</dt>
                  <dd className={cn("min-w-0 break-words", r.code && "font-mono text-[12.5px]")}>{r.value}</dd>
                </div>
              ))}
            </dl>
          ))}
        </div>
      </div>
      <div className="order-3 flex flex-col justify-around gap-4 lg:order-none">
        {right.map((p) => (
          <Note key={p.key} p={p} align="left" />
        ))}
      </div>
    </div>
  );
}
