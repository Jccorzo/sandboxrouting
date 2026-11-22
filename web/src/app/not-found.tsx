import Link from "next/link";

export default function NotFound() {
  return (
    <section className="wrap pt-20 lg:pt-32">
      <h1 className="text-[clamp(2.6rem,1.2rem+5.2vw,5rem)] leading-[0.98] tracking-[-0.035em]">No box at this address</h1>
      <p className="mt-6 max-w-[48ch] text-[19px] leading-relaxed">Every provider refused this one. Try the next in the plan:</p>
      <ul className="mt-6 flex flex-wrap gap-2 text-[16px] font-medium">
        {[
          ["/", "Home"],
          ["/providers/", "Providers"],
          ["/docs/", "Docs"],
          ["/quickstart/", "Quickstart"],
        ].map(([href, label]) => (
          <li key={href}>
            <Link href={href!} className="inline-block bg-tone-1 px-4 py-2.5 hover:bg-tone-2">
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
