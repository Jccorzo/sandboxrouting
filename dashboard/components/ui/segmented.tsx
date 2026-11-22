"use client";

import { ToggleGroup } from "radix-ui";
import { cn } from "@/lib/utils";

/** A small single-choice control (range, metric, view). Radix ToggleGroup: arrow keys move, one is always on. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: readonly { value: T; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onChange(v as T)}
      aria-label={label}
      className={cn("inline-flex h-8 items-center rounded-md border border-input bg-background p-0.5", className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className="h-full rounded-[5px] px-2.5 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground data-[state=on]:bg-foreground data-[state=on]:text-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
