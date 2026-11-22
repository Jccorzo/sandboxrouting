"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Mark } from "./mark";

const LINKS = [
  { href: "/how-routing-works/", label: "How it routes" },
  { href: "/providers/", label: "Providers" },
  { href: "/docs/", label: "Docs" },
  { href: "/mcp/", label: "MCP" },
];

export function Nav() {
  const pathname = usePathname();
  // The menu is open at the page it was opened on; landing anywhere else closes it, with no effect to run.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const setOpen = (fn: (v: boolean) => boolean) => setOpenAt(fn(open) ? pathname : null);

  const active = (href: string) => pathname === href || pathname.startsWith(href);

  return (
    <header className="relative z-40 bg-ground">
      <div className="wrap flex h-[72px] items-center justify-between gap-6">
        <Link href="/" className="flex items-center gap-2.5 text-[19px] font-semibold tracking-[-0.03em]" aria-label="sandboxrouting home">
          <Mark size={22} />
          sandboxrouting
        </Link>
        <nav aria-label="Main" className="hidden items-center gap-8 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={cn(
                "text-[15px] font-medium transition-colors hover:text-green-ink",
                active(l.href) ? "text-ink underline decoration-green decoration-2 underline-offset-[10px]" : "text-ink",
              )}
            >
              {l.label}
            </Link>
          ))}
          <Link href="/quickstart/" className="inline-flex h-10 items-center bg-ink px-4 text-[15px] font-medium text-ground transition-[background-color,transform] hover:bg-[#2b2b29] active:scale-[0.98]">
            Quickstart
          </Link>
        </nav>
        <button
          type="button"
          className="inline-flex h-10 items-center px-3 text-[15px] font-medium md:hidden bg-tone-1"
          aria-expanded={open}
          aria-controls="mobile-menu"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Close" : "Menu"}
        </button>
      </div>
      {open ? (
        <nav id="mobile-menu" aria-label="Main" className="absolute inset-x-0 top-[72px] bg-ground pb-6 md:hidden">
          <ul className="wrap flex flex-col">
            {[...LINKS, { href: "/quickstart/", label: "Quickstart" }].map((l) => (
              <li key={l.href}>
                <Link href={l.href} className={cn("block py-3 text-[26px] font-semibold tracking-[-0.03em]", active(l.href) && "text-green-ink")}>
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
