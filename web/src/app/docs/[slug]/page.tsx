import { notFound } from "next/navigation";
import { DocArticle } from "@/components/docs/doc-article";
import { JsonLd } from "@/components/site/json-ld";
import { docPath, loadDocs } from "@/lib/docs";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const dynamicParams = false;

export function generateStaticParams() {
  return loadDocs()
    .pages.filter((p) => p.slug !== "overview")
    .map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = loadDocs().pages.find((p) => p.slug === slug);
  if (!page) return {};
  return pageMetadata({ title: page.title, description: page.summary || `${page.title}, from sandboxrouting's ${page.source}.`, path: docPath(page.slug), og: `doc-${page.slug}` });
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const page = loadDocs().pages.find((p) => p.slug === slug && slug !== "overview");
  if (!page) notFound();
  return (
    <>
      <JsonLd data={breadcrumbLd([{ name: "Home", path: "/" }, { name: "Docs", path: "/docs/" }, { name: page.title, path: docPath(page.slug) }])} />
      <DocArticle page={page} />
    </>
  );
}
