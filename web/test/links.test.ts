import { describe, expect, it } from "vitest";
import { REPO_URL, rewriteHref, type LinkContext } from "../src/lib/links";

const ctx: LinkContext = {
  source: "README.md",
  pages: { "README.md": "/docs/", "docs/routing.md": "/docs/routing/", "docs/providers-iam.md": "/docs/providers-iam/" },
  anchors: {
    "README.md": { "off-by-default": "/docs/providers/", metering: "/docs/how-a-provider-is-chosen/" },
    "docs/routing.md": { "active-cpu-billing": "/docs/routing/" },
  },
  isDirectory: (p) => p === "templates/cloudflare-worker" || p === "templates/cloud-run-sandbox",
};

describe("rewriteHref", () => {
  it("leaves absolute URLs alone", () => {
    expect(rewriteHref("https://modal.com/pricing", ctx)).toBe("https://modal.com/pricing");
    expect(rewriteHref("mailto:a@b.c", ctx)).toBe("mailto:a@b.c");
  });

  it("sends an in-page anchor to the README section that holds it", () => {
    expect(rewriteHref("#off-by-default", ctx)).toBe("/docs/providers/#off-by-default");
    expect(rewriteHref("#metering", ctx)).toBe("/docs/how-a-provider-is-chosen/#metering");
  });

  it("maps rendered markdown files, with their anchors, to site pages", () => {
    expect(rewriteHref("docs/routing.md", ctx)).toBe("/docs/routing/");
    expect(rewriteHref("docs/routing.md#active-cpu-billing", ctx)).toBe("/docs/routing/#active-cpu-billing");
    expect(rewriteHref("docs/providers-iam.md", ctx)).toBe("/docs/providers-iam/");
  });

  it("resolves paths relative to the file they are written in", () => {
    expect(rewriteHref("../templates/cloud-run-sandbox", { ...ctx, source: "docs/providers-iam.md" })).toBe(`${REPO_URL}/tree/main/templates/cloud-run-sandbox`);
    expect(rewriteHref("routing.md#active-cpu-billing", { ...ctx, source: "docs/agentrun.md" })).toBe("/docs/routing/#active-cpu-billing");
  });

  it("sends other repository files to GitHub, directories as trees", () => {
    expect(rewriteHref("src/server/http.ts", ctx)).toBe(`${REPO_URL}/blob/main/src/server/http.ts`);
    expect(rewriteHref("templates/cloudflare-worker", ctx)).toBe(`${REPO_URL}/tree/main/templates/cloudflare-worker`);
    expect(rewriteHref("LICENSE", ctx)).toBe(`${REPO_URL}/blob/main/LICENSE`);
  });

  it("leaves a path that climbs out of the repository as written", () => {
    expect(rewriteHref("../../elsewhere.md", ctx)).toBe("../../elsewhere.md");
  });
});
