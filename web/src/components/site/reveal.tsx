"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Lets the parts of each section rise in once as they enter. Content is visible without script:
 * only this effect adds the class that hides it, and it marks everything already on screen as in
 * before the first paint it influences.
 */
export function Reveal() {
  const pathname = usePathname();
  useEffect(() => {
    const root = document.documentElement;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]:not(.is-in)"));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) el.classList.add("is-in");
      else io.observe(el);
    }
    root.classList.add("js-reveal");
    return () => io.disconnect();
  }, [pathname]);
  return null;
}
