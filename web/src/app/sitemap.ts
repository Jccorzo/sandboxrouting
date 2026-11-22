import type { MetadataRoute } from "next";
import { providers, site } from "@/lib/data";
import { docPath, loadDocs } from "@/lib/docs";
import { canonical } from "@/lib/seo";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const built = new Date(site.asOf);
  const page = (path: string, priority: number, lastModified = built): MetadataRoute.Sitemap[number] => ({ url: canonical(path), lastModified, priority });
  return [
    page("/", 1),
    page("/how-routing-works/", 0.9),
    page("/quickstart/", 0.9),
    page("/mcp/", 0.9),
    page("/providers/", 0.8),
    page("/compare/", 0.6),
    ...loadDocs().pages.map((d) => page(docPath(d.slug), 0.7)),
    // A provider's page changes when its terms were last checked.
    ...providers.map((p) => page(`/providers/${p.id}/`, 0.6, p.checked ? new Date(`${p.checked}T12:00:00Z`) : built)),
    ...site.comparisons.map((c) => page(`/compare/${c.slug}/`, 0.5)),
  ];
}
