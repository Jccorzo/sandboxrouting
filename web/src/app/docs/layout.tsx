import { DocsNav } from "@/components/docs/docs-nav";
import { docPath, loadDocs } from "@/lib/docs";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const { pages } = loadDocs();
  const groups = (["Guide", "Design"] as const).map((g) => ({
    name: g === "Guide" ? "README" : "Design docs",
    items: pages.filter((p) => p.group === g).map((p) => ({ href: docPath(p.slug), label: p.title })),
  }));
  return (
    <div className="wrap grid gap-10 pt-10 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-16 lg:pt-16">
      <DocsNav groups={groups} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
