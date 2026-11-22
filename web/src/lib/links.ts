// Where a link written in the repository's markdown goes on the site. One function decides it
// for the docs pages and for the README cells on provider pages, so the two can't disagree.
//
//   https://…                  unchanged
//   #anchor                    the docs page that holds that heading (the README is split by section)
//   docs/routing.md#x          /docs/routing/#x (any markdown file the site renders)
//   src/server/http.ts         the file on GitHub (anything else in the repository)

import { posix } from "node:path";

export const REPO_URL = "https://github.com/Jccorzo/sandboxrouting";
export const REPO_BRANCH = "main";

export interface LinkContext {
  /** The repository-relative path of the markdown file the link is written in, e.g. "docs/routing.md". */
  source: string;
  /** Repository-relative markdown file → site path, for every file the site renders. */
  pages: Record<string, string>;
  /** For each rendered file, heading id → the site path of the page that shows it. */
  anchors: Record<string, Record<string, string>>;
  /** Whether a repository path is a directory (GitHub wants /tree/ for those). */
  isDirectory?: (repoPath: string) => boolean;
}

export function rewriteHref(href: string, ctx: LinkContext): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) return href;

  const hashAt = href.indexOf("#");
  const pathPart = hashAt === -1 ? href : href.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : href.slice(hashAt + 1);

  const target = pathPart === "" ? ctx.source : posix.normalize(posix.join(posix.dirname(ctx.source), pathPart));
  if (target.startsWith("..")) return href; // outside the repository: leave it as written

  const page = ctx.pages[target];
  if (page !== undefined) {
    const anchorPage = hash ? ctx.anchors[target]?.[hash] : undefined;
    const base = anchorPage ?? page;
    return hash ? `${base}#${hash}` : base;
  }

  const clean = target.replace(/\/$/, "");
  const kind = ctx.isDirectory?.(clean) ? "tree" : "blob";
  return `${REPO_URL}/${kind}/${REPO_BRANCH}/${clean}${hash ? `#${hash}` : ""}`;
}
