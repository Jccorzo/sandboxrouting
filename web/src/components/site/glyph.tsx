import { cn } from "@/lib/utils";

/** The diagrams' three marks, drawn: created (check), refused (cross), skipped (dash). */
export function Glyph({ kind, className }: { kind: "ok" | "fail" | "skip"; className?: string }) {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" className={cn("inline-block shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="2">
      {kind === "ok" ? <path d="M2 6.5 4.8 9.2 10 3" /> : kind === "fail" ? <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" /> : <path d="M2.5 6h7" />}
    </svg>
  );
}
