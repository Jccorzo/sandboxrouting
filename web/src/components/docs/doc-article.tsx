import Link from "next/link";
import { docPath, loadDocs, renderDoc, type DocPage } from "@/lib/docs";
import { REPO_URL } from "@/lib/links";

/** One docs page: the repository's markdown, rendered at build time, with its own contents list. */
export async function DocArticle({ page }: { page: DocPage }) {
  const { pages } = loadDocs();
  const html = await renderDoc({ ...page, markdown: page.markdown.replace(/^## .*\n/, "") });
  const at = pages.findIndex((p) => p.slug === page.slug);
  const prev = pages[at - 1];
  const next = pages[at + 1];
  const toc = page.headings.filter((h) => (page.source === "README.md" ? h.depth === 3 : h.depth === 2 || h.depth === 3));

  return (
    <div className="grid gap-12 xl:grid-cols-[minmax(0,1fr)_220px]">
      <article className="min-w-0">
        <h1 className="text-[clamp(2.4rem,1.2rem+4vw,4rem)] leading-[1] tracking-[-0.035em]">{page.title}</h1>
        <p className="mt-4 text-[14px] text-muted">
          From{" "}
          <a href={`${REPO_URL}/blob/main/${page.source}`} className="underline decoration-green">
            {page.source}
          </a>
          , rendered when the site was built.
        </p>
        <div className="prose-doc mt-10" dangerouslySetInnerHTML={{ __html: html }} />
        <nav aria-label="Next and previous" className="mt-16 grid gap-[6px] sm:grid-cols-2">
          {prev ? (
            <Link href={docPath(prev.slug)} className="bg-tone-1 p-5 transition-colors hover:bg-tone-2">
              <span className="block text-[13px] text-muted">Previous</span>
              <span className="text-[18px] font-medium">{prev.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link href={docPath(next.slug)} className="bg-tone-1 p-5 text-right transition-colors hover:bg-tone-2">
              <span className="block text-[13px] text-muted">Next</span>
              <span className="text-[18px] font-medium">{next.title}</span>
            </Link>
          ) : null}
        </nav>
      </article>
      {toc.length > 1 ? (
        <aside className="hidden xl:block">
          <div className="sticky top-6">
            <p className="text-[14px] font-semibold">On this page</p>
            <ul className="mt-2 space-y-1.5 text-[14px]">
              {toc.map((h) => (
                <li key={h.id} className={h.depth === 3 && page.source !== "README.md" ? "pl-3" : ""}>
                  <a href={`#${h.id}`} className="text-muted hover:text-ink">
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
