"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type CopyState = "idle" | "copied" | "failed";

/**
 * Copies text. It says "Copied" only once the clipboard says it worked, and "Couldn't copy" when
 * it refused (no permission, an insecure origin). Each press is a generation: a slow answer to an
 * older press can't overwrite a newer one, and the label goes back to idle on every outcome.
 */
export function CopyButton({ text, className, label = "Copy", tone = "light" }: { text: string; className?: string; label?: string; tone?: "light" | "dark" }) {
  const [state, setState] = useState<CopyState>("idle");
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const mine = ++generation.current;
    clearTimeout(timer.current);
    let next: CopyState;
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(text);
      next = "copied";
    } catch {
      next = "failed";
    }
    if (mine !== generation.current) return;
    setState(next);
    timer.current = setTimeout(() => {
      if (mine === generation.current) setState("idle");
    }, 1800);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-live="polite"
      className={cn(
        "inline-flex h-8 min-w-[72px] items-center justify-center px-3 text-[13px] font-medium transition-[background-color,color,transform] duration-150 active:scale-[0.97]",
        tone === "light" ? "bg-ground text-ink hover:bg-tone-2" : "bg-ink text-ground hover:bg-[#2a2a28]",
        state === "copied" && "bg-green text-ink hover:bg-green",
        className,
      )}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy" : label}
    </button>
  );
}
