"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CloudOff, RotateCw } from "lucide-react";
import type { Failure } from "@/lib/api";
import type { PollView } from "@/lib/poll-state";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { cn } from "@/lib/utils";

export function PageHeader({ title, description, children }: { title: string; description: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
        <p className="mt-1.5 max-w-[68ch] text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

export function Section({ title, description, action, children, className }: { title: string; description?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("mt-10 first:mt-0", className)}>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

const message = (f: Failure) => (f.kind === "network" ? f.message : f.kind === "unauthorized" ? "Your session ended. Sign in again." : f.message);

/** How fresh the view is: polling quietly, or why it couldn't refresh and how old what's shown is. */
export function Freshness<T>({ view, onRetry }: { view: PollView<T>; onRetry: () => void }) {
  // The browser's clock, read in an effect: only for "how long ago did this page fetch".
  const [clock, setClock] = useState(0);
  useEffect(() => {
    const read = () => setClock(Date.now());
    read();
    const t = setInterval(read, 5_000);
    return () => clearInterval(t);
  }, [view]);
  if (view.status !== "ready") return null;
  const age = Math.max(0, Math.round((clock - view.fetchedAt) / 1000));
  const ago = age < 5 ? "just now" : age < 60 ? `${age} s ago` : `${Math.round(age / 60)} min ago`;
  if (view.failure) {
    return (
      <div role="status" className="inline-flex items-center gap-2 rounded-md bg-warning-wash px-2.5 py-1 text-[12.5px] text-warning-ink">
        <CloudOff className="size-3.5" />
        <span>Couldn&apos;t refresh: {message(view.failure)} Showing data from {ago}.</span>
        <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
          Retry
        </button>
      </div>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground" aria-live="polite">
      <span className={cn("size-1.5 rounded-full bg-brand", view.refreshing && "animate-pulse")} aria-hidden />
      Updated {ago}
    </span>
  );
}

export function ErrorState({ failure, retrying, onRetry }: { failure: Failure; retrying: boolean; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-xl border border-critical/25 bg-critical-wash px-5 py-5">
      <div className="flex items-center gap-2 text-sm font-medium text-critical">
        <AlertTriangle className="size-4" />
        {failure.kind === "network" ? "Can't load this right now" : "This didn't load"}
      </div>
      <p className="max-w-[60ch] text-[13px] text-foreground/80">
        {message(failure)} {failure.kind === "network" ? "The dashboard will keep trying; nothing is lost while back is away." : ""}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
        <RotateCw className={cn(retrying && "animate-spin")} />
        {retrying ? "Trying again…" : "Try again"}
      </Button>
    </div>
  );
}

export function EmptyState({ title, children, icon: Icon }: { title: string; children: React.ReactNode; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="rounded-xl border border-dashed border-input px-6 py-10">
      <div className="mx-auto flex max-w-[52ch] flex-col items-center text-center">
        {Icon && <Icon className="mb-3 size-5 text-faint" />}
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-0" aria-busy="true" aria-label="Loading">
      <div className="flex gap-6 border-b pb-3">
        {Array.from({ length: cols }, (_, i) => (
          <Skeleton key={i} className="h-3 w-20" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-6 border-b py-3.5">
          {Array.from({ length: cols }, (_, i) => (
            <Skeleton key={i} className={cn("h-3.5", i === 0 ? "w-36" : "w-16")} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Renders a polled view's loading and error states; `children` gets the data once there is some. */
export function Loaded<T>({ view, refresh, skeleton, children }: { view: PollView<T> & { refresh: () => void }; refresh?: () => void; skeleton: React.ReactNode; children: (data: T) => React.ReactNode }) {
  if (view.status === "loading") return <>{skeleton}</>;
  if (view.status === "error") return <ErrorState failure={view.failure} retrying={view.retrying} onRetry={refresh ?? view.refresh} />;
  return <>{children(view.data)}</>;
}

/** A quiet stat: label above, figure below. Several sit in one row with hairlines between them. */
export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="min-w-0 px-0 py-1 sm:px-5 sm:first:pl-0">
      <div className="text-[12.5px] text-muted-foreground">{label}</div>
      <div className="tabular mt-1 text-[22px] font-semibold leading-none tracking-[-0.02em]">{value}</div>
      {hint && <div className="mt-1.5 text-[12px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
