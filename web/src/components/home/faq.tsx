import { FAQ } from "@/lib/faq";

/** One question open at a time (`<details name>`), no script needed. */
export function Faq({ items = FAQ, title = "Before you ask" }: { items?: { q: string; a: string }[]; title?: string }) {
  return (
    <section className="wrap mt-[var(--section)]" id="faq">
      <div className="grid gap-8 lg:grid-cols-12 lg:gap-10">
        <h2 data-reveal className="text-[clamp(2.25rem,9vw,3.5rem)] tracking-[-0.035em] lg:sticky lg:top-24 lg:col-span-4 lg:self-start lg:text-[4vw]">
          {title}
        </h2>
        <div className="space-y-[6px] lg:col-span-8">
          {items.map((f, i) => (
            <details key={f.q} name="faq" className="group bg-tone-1 open:bg-green [&_summary::-webkit-details-marker]:hidden" open={i === 0}>
              <summary className="flex min-h-[64px] cursor-pointer list-none items-center justify-between gap-6 px-5 py-4 text-[18px] font-medium transition-colors hover:bg-tone-2 group-open:hover:bg-transparent sm:min-h-[72px] sm:px-6 sm:text-[20px]">
                {f.q}
                <span className="relative block size-4 shrink-0" aria-hidden="true">
                  <span className="absolute left-0 top-[6.5px] h-[3px] w-4 bg-ink" />
                  <span className="absolute left-0 top-[6.5px] h-[3px] w-4 rotate-90 bg-ink transition-transform duration-300 group-open:rotate-0" />
                </span>
              </summary>
              <p className="max-w-[60ch] px-5 pb-6 text-[16px] leading-relaxed sm:px-6 sm:text-[17px]">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
