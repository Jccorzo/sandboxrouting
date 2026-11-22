"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function DocsNav({ groups }: { groups: { name: string; items: { href: string; label: string }[] }[] }) {
  const pathname = usePathname();
  // The menu is open at the page it was opened on; landing anywhere else closes it, with no effect to run.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const setOpen = (fn: (v: boolean) => boolean) => setOpenAt(fn(open) ? pathname : null);
  const current = groups.flatMap((g) => g.items).find((i) => i.href === pathname);
  return (
    <nav aria-label="Docs" className="lg:sticky lg:top-6 lg:max-h-[calc(100dvh-48px)] lg:self-start lg:overflow-y-auto">
      <button type="button" className="flex h-11 w-full items-center justify-between bg-tone-1 px-4 text-[15px] font-medium lg:hidden" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span>{current?.label ?? "Docs"}</span>
        <span className="text-muted">{open ? "Close" : "All pages"}</span>
      </button>
      <div className={cn("mt-3 space-y-8 lg:mt-0 lg:block", open ? "block" : "hidden")}>
        {groups.map((g) => (
          <div key={g.name}>
            <p className="text-[14px] font-semibold">{g.name}</p>
            <ul className="mt-2 space-y-0.5">
              {g.items.map((i) => (
                <li key={i.href}>
                  <Link
                    href={i.href}
                    className={cn("block px-2 py-1.5 text-[15px] transition-colors", pathname === i.href ? "bg-ink text-ground" : "text-ink hover:bg-tone-1")}
                  >
                    {i.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
