"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { Activity, Boxes, ChartColumnBig, KeyRound, Layers, LogOut, Route, ShieldAlert, Loader2 } from "lucide-react";
import type { Me } from "@sandboxrouting/back/api";
import { Mark } from "./mark";
import { ProviderColors } from "./provider-colors";
import { usePoll } from "@/lib/use-poll";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: ChartColumnBig },
  { href: "/providers", label: "Providers", icon: Layers },
  { href: "/health", label: "Health", icon: Activity },
  { href: "/refusals", label: "Refusals", icon: ShieldAlert },
  { href: "/sandboxes", label: "Sandboxes", icon: Boxes },
  { href: "/jobs", label: "Jobs", icon: Route },
  { href: "/keys", label: "API keys", icon: KeyRound },
] as const;

function SignOut() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const res = await fetch("/api/session", { method: "DELETE", headers: { "x-requested-with": "sbr-dashboard" } }).catch(() => undefined);
        if (!res?.ok) {
          setBusy(false);
          return;
        }
        // Busy until the sign-in page has replaced this one.
        router.replace("/login");
        router.refresh();
      }}
      className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-60"
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
      Sign out
    </button>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const me = usePoll<Me>("me", 120_000);
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[232px_1fr]">
      <aside className="sticky top-0 z-20 border-b bg-panel lg:h-dvh lg:border-b-0 lg:border-r">
        <div className="flex h-14 items-center gap-2.5 px-4 lg:h-16 lg:px-5">
          <Mark className="size-5" />
          <span className="text-[14px] font-semibold tracking-[-0.01em]">sandboxrouting</span>
          <div className="ml-auto lg:hidden">
            <SignOut />
          </div>
        </div>
        <nav aria-label="Dashboard" className="flex gap-1 overflow-x-auto px-3 pb-2 lg:flex-col lg:overflow-visible lg:px-3 lg:pb-0">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={active(href) ? "page" : undefined}
              className={cn(
                "group relative flex shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13.5px] transition-colors duration-150",
                active(href) ? "bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(11,11,11,0.06)] ring-1 ring-border" : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className={cn("size-4", active(href) ? "text-brand-ink" : "text-faint group-hover:text-muted-foreground")} strokeWidth={1.75} />
              {label}
            </Link>
          ))}
        </nav>
        <div className="absolute inset-x-0 bottom-0 hidden border-t px-3 py-3 lg:block">
          <div className="truncate px-2 pb-1 text-[12px] text-faint">Account</div>
          <div className="truncate px-2 pb-2 text-[13px] font-medium">{me.status === "ready" ? me.data.account.name : "—"}</div>
          <SignOut />
        </div>
      </aside>
      <main className="min-w-0">
        <div className="mx-auto w-full max-w-[1240px] px-4 pb-16 pt-6 sm:px-6 lg:px-10 lg:pt-10">
          <ProviderColors>{children}</ProviderColors>
        </div>
      </main>
    </div>
  );
}
