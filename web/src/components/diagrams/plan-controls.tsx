"use client";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { Controls } from "./use-plan";

const NEED_LABEL: Record<string, string> = { ports: "ports", gpu: "gpu", customImage: "customImage", pause: "pause" };

function Segmented({ label, value, options, onChange, format }: { label: string; value: string; options: string[]; onChange: (v: string) => void; format?: (v: string) => string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((o) => {
        const on = o === value;
        return (
          <button
            key={o}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o)}
            className={cn(
              "h-8 rounded-[5px] px-2.5 text-[13px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.97]",
              on ? "bg-ink text-ground" : "bg-ground text-ink hover:bg-tone-2",
            )}
          >
            {format ? format(o) : o}
          </button>
        );
      })}
    </div>
  );
}

export function PlanControls({
  controls,
  onChange,
  options,
  className,
}: {
  controls: Controls;
  onChange: (c: Controls) => void;
  options: { strategies: string[]; needs: string[]; isolation: string[] };
  className?: string;
}) {
  const toggleNeed = (n: string) =>
    onChange({ ...controls, needs: controls.needs.includes(n) ? controls.needs.filter((x) => x !== n) : [...controls.needs, n] });

  return (
    <div className={cn("grid gap-x-5 gap-y-3 text-[13px] sm:grid-cols-[auto_1fr] sm:items-center", className)}>
      <span className="font-medium text-muted">strategy</span>
      <Segmented label="Strategy" value={controls.strategy} options={options.strategies} onChange={(strategy) => onChange({ ...controls, strategy })} />

      <span className="font-medium text-muted">needs</span>
      <div role="group" aria-label="Capabilities the sandbox needs" className="flex flex-wrap gap-1">
        {options.needs.map((n) => {
          const on = controls.needs.includes(n);
          return (
            <button
              key={n}
              type="button"
              aria-pressed={on}
              onClick={() => toggleNeed(n)}
              className={cn(
                "h-8 rounded-[5px] px-2.5 transition-[background-color,color,transform] duration-150 active:scale-[0.97]",
                on ? "bg-ink text-ground" : "bg-ground text-ink hover:bg-tone-2",
              )}
            >
              <code className="text-[12.5px]">{NEED_LABEL[n] ?? n}</code>
            </button>
          );
        })}
      </div>

      <span className="font-medium text-muted">minIsolation</span>
      <Segmented
        label="Weakest isolation acceptable"
        value={controls.minIsolation}
        options={options.isolation}
        onChange={(minIsolation) => onChange({ ...controls, minIsolation })}
        format={(v) => v || "any"}
      />

      <span className="font-medium text-muted">allowPaid</span>
      <label className="flex items-center gap-2.5">
        <Switch
          checked={controls.allowPaid}
          onCheckedChange={(allowPaid) => onChange({ ...controls, allowPaid })}
          className="data-[state=checked]:bg-ink data-[state=unchecked]:bg-tone-3"
          aria-label="Allow paid usage"
        />
        <span className="text-[13px]">{controls.allowPaid ? "true: paid usage after the free tiers" : "false: nothing is ever billed"}</span>
      </label>
    </div>
  );
}
