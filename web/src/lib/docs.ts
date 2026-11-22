// The docs, built at build time from the repository's own markdown: README.md split at its
// second-level headings, plus the design docs under docs/. Nothing is copied: change the README
// and the next build shows it. Links are rewritten by links.ts; code is highlighted by Shiki.

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import GithubSlugger from "github-slugger";
import type { Element, Root as HastRoot } from "hast";
import type { Root as MdRoot, Link, Heading } from "mdast";
import { toString } from "mdast-util-to-string";
import rehypeShiki from "@shikijs/rehype";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { createCssVariablesTheme } from "shiki";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { rewriteHref, type LinkContext } from "./links";

export interface DocHeading {
  depth: number;
  text: string;
  id: string;
}

export interface DocPage {
  slug: string;
  title: string;
  /** One line for the index and the page's meta description. */
  summary: string;
  /** Repository-relative path of the file it comes from. */
  source: string;
  markdown: string;
  headings: DocHeading[];
  group: "Guide" | "Design";
}

/** The repository root: the nearest directory above the working directory with README.md and src/core. */
export function repoRoot(from = process.cwd()): string {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, "README.md")) && existsSync(path.join(dir, "src", "core"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) throw new Error(`no repository root above ${from}`);
    dir = up;
  }
}

/** Design docs rendered whole, each at its own path. */
const FILES: { source: string; slug: string; group: DocPage["group"] }[] = [
  { source: "docs/routing.md", slug: "routing", group: "Design" },
  { source: "docs/agentrun.md", slug: "agentrun-connector", group: "Design" },
  { source: "docs/providers-iam.md", slug: "providers-iam", group: "Design" },
];

export const docPath = (slug: string) => (slug === "overview" ? "/docs/" : `/docs/${slug}/`);

/** Splits markdown at `## ` headings outside code fences; the part before the first is the preamble. */
export function splitSections(markdown: string): { title?: string; body: string }[] {
  const lines = markdown.split("\n");
  const out: { title?: string; body: string[] }[] = [{ body: [] }];
  let fence: string | undefined;
  for (const line of lines) {
    const f = /^(```+|~~~+)/.exec(line);
    if (f) fence = fence === undefined ? f[1] : line.startsWith(fence) ? undefined : fence;
    if (fence === undefined && line.startsWith("## ")) out.push({ title: line.slice(3).trim(), body: [line] });
    else out[out.length - 1]!.body.push(line);
  }
  return out.map((s) => ({ title: s.title, body: s.body.join("\n") }));
}

function headingsOf(markdown: string, slugger: GithubSlugger): DocHeading[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as MdRoot;
  const out: DocHeading[] = [];
  visit(tree, "heading", (h: Heading) => {
    const text = toString(h);
    out.push({ depth: h.depth, text, id: slugger.slug(text) });
  });
  return out;
}

function firstSentence(markdown: string): string {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown) as MdRoot;
  const para = tree.children.find((n) => n.type === "paragraph");
  const text = para ? toString(para).replace(/\s+/g, " ").trim() : "";
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  const s = (m ? m[1]! : text).trim();
  return s.length > 180 ? `${s.slice(0, 177).trimEnd()}…` : s;
}

let cache: { pages: DocPage[]; ctx: Omit<LinkContext, "source"> } | undefined;

/** Every docs page, in reading order, and the link context that maps the repository onto them. */
export function loadDocs(root = repoRoot()): { pages: DocPage[]; ctx: Omit<LinkContext, "source"> } {
  if (cache) return cache;
  const pages: DocPage[] = [];
  const anchors: LinkContext["anchors"] = {};

  // README.md: one page per section. Heading ids are slugged over the whole file, as GitHub does.
  const readme = readFileSync(path.join(root, "README.md"), "utf8");
  const slugger = new GithubSlugger();
  anchors["README.md"] = {};
  for (const section of splitSections(readme)) {
    const body = section.title === undefined ? section.body.replace(/^# .*\n/, "") : section.body;
    const heads = headingsOf(section.title === undefined ? section.body : body, slugger);
    const slug = section.title === undefined ? "overview" : heads[0]!.id;
    const title = section.title ?? "Overview";
    const shown = section.title === undefined ? heads.filter((h) => h.depth > 1) : heads;
    for (const h of shown) anchors["README.md"][h.id] = docPath(slug);
    pages.push({ slug, title, summary: firstSentence(body.replace(/^## .*\n/, "")), source: "README.md", markdown: body, headings: shown, group: "Guide" });
  }

  for (const f of FILES) {
    const md = readFileSync(path.join(root, f.source), "utf8");
    const heads = headingsOf(md, new GithubSlugger());
    const h1 = heads.find((h) => h.depth === 1);
    anchors[f.source] = Object.fromEntries(heads.map((h) => [h.id, docPath(f.slug)]));
    const body = md.replace(/^# .*\n/, "");
    pages.push({
      slug: f.slug,
      title: h1?.text ?? f.slug,
      summary: firstSentence(body),
      source: f.source,
      markdown: body,
      headings: heads.filter((h) => h.depth > 1),
      group: f.group,
    });
  }

  const pageOf: Record<string, string> = { "README.md": docPath("overview") };
  for (const f of FILES) pageOf[f.source] = docPath(f.slug);
  const isDirectory = (p: string) => {
    try {
      return statSync(path.join(root, p)).isDirectory();
    } catch {
      return false;
    }
  };
  cache = { pages, ctx: { pages: pageOf, anchors, isDirectory } };
  return cache;
}

/** Shiki writes CSS variables, so code takes the site's palette (globals.css sets them). */
export const codeTheme = createCssVariablesTheme({ name: "sbr", variablePrefix: "--code-", fontStyle: true });

function remarkLinks(ctx: LinkContext) {
  return (tree: MdRoot) => {
    visit(tree, ["link", "definition"], (node) => {
      const n = node as Link;
      n.url = rewriteHref(n.url, ctx);
    });
  };
}

/** Wide tables scroll inside their own box on a phone instead of widening the page. */
function rehypeTableScroll() {
  return (tree: HastRoot) => {
    visit(tree, "element", (node: Element, index, parent) => {
      if (node.tagName !== "table" || !parent || index === undefined) return;
      if (parent.type === "element" && String((parent as Element).properties?.className) === "table-scroll") return;
      parent.children[index] = { type: "element", tagName: "div", properties: { className: ["table-scroll"] }, children: [node] };
    });
  };
}

/** Markdown → HTML with the site's links, heading ids and code highlighting. */
export async function renderMarkdown(markdown: string, ctx: LinkContext): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkLinks, ctx)
    .use(remarkRehype)
    .use(rehypeTableScroll)
    .use(rehypeSlug)
    .use(rehypeShiki, { theme: codeTheme, langs: ["ts", "js", "bash", "json", "jsonc", "yaml", "toml"], addLanguageClass: true, defaultLanguage: "text" })
    .use(rehypeStringify)
    .process(markdown);
  return String(file);
}

export async function renderDoc(page: DocPage): Promise<string> {
  const { ctx } = loadDocs();
  return renderMarkdown(page.markdown, { ...ctx, source: page.source });
}
