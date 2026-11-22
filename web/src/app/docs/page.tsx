import { DocArticle } from "@/components/docs/doc-article";
import { loadDocs } from "@/lib/docs";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Docs",
  description: "sandboxrouting's documentation, built from its README and design docs: providers, how a provider is chosen, jobs, the SDK, CLI, REST API and MCP server, configuration and adding a provider.",
  path: "/docs/",
  og: "doc-overview",
});

export default function DocsIndex() {
  const page = loadDocs().pages.find((p) => p.slug === "overview")!;
  return <DocArticle page={page} />;
}
