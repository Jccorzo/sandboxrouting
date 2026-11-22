import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { docPath, loadDocs, renderDoc, repoRoot, splitSections } from "../src/lib/docs";
import { REPO_URL } from "../src/lib/links";

const root = repoRoot();

describe("splitSections", () => {
  it("splits at second-level headings, but not inside code fences", () => {
    const md = ["# Title", "intro", "## One", "a", "```md", "## not a heading", "```", "## Two", "b"].join("\n");
    const parts = splitSections(md);
    expect(parts.map((p) => p.title)).toEqual([undefined, "One", "Two"]);
    expect(parts[1]!.body).toContain("## not a heading");
  });
});

describe("the docs", () => {
  const { pages } = loadDocs(root);

  it("give every README section a page, in order", () => {
    const readme = readFileSync(path.join(root, "README.md"), "utf8");
    const titles = splitSections(readme).flatMap((s) => (s.title ? [s.title] : []));
    expect(pages.filter((p) => p.source === "README.md").map((p) => p.title)).toEqual(["Overview", ...titles]);
    expect(new Set(pages.map((p) => p.slug)).size).toBe(pages.length);
  });

  it("only link to pages that exist, headings that exist, or GitHub", async () => {
    const paths = new Set(pages.map((p) => docPath(p.slug)));
    const ids = new Map<string, Set<string>>();
    const htmls = new Map<string, string>();
    for (const p of pages) {
      const html = await renderDoc(p);
      htmls.set(docPath(p.slug), html);
      ids.set(docPath(p.slug), new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!)));
    }
    const bad: string[] = [];
    for (const [page, html] of htmls) {
      for (const [, href] of html.matchAll(/ href="([^"]+)"/g)) {
        if (/^(https?:|mailto:)/.test(href!) && !href!.startsWith(REPO_URL)) continue;
        if (href!.startsWith(REPO_URL)) {
          const rel = href!.replace(new RegExp(`^${REPO_URL}/(blob|tree)/main/`), "").split("#")[0]!;
          try {
            readFileSync(path.join(root, rel));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EISDIR") bad.push(`${page}: ${href} (no such file)`);
          }
          continue;
        }
        const [target, hash] = href!.startsWith("#") ? [page, href!.slice(1)] : href!.split("#");
        if (!paths.has(target!)) bad.push(`${page}: ${href} (no such page)`);
        else if (hash && !ids.get(target!)!.has(hash) && !hash.startsWith("user-content-fn")) bad.push(`${page}: ${href} (no such heading)`);
      }
    }
    expect(bad).toEqual([]);
  });
});
