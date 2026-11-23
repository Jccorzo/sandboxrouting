import { describe, expect, it } from "vitest";
import { FEATURED_CLIENTS, MCP_CLIENTS } from "../src/lib/mcp-clients";

describe("MCP client snippets", () => {
  it("have unique ids, which the page uses as anchors", () => {
    expect(new Set(MCP_CLIENTS.map((c) => c.id)).size).toBe(MCP_CLIENTS.length);
  });

  it("feature only clients that exist", () => {
    for (const id of FEATURED_CLIENTS) expect(MCP_CLIENTS.map((c) => c.id)).toContain(id);
  });

  it.each(MCP_CLIENTS.map((c) => [c.name, c] as const))("%s: names the server, runs the package and passes a key", (_, c) => {
    const s = c.snippet("my-box");
    expect(s).toContain("my-box");
    expect(s).toMatch(/sandboxrouting/);
    expect(s).toMatch(/\bmcp\b/);
    expect(s).toContain("E2B_API_KEY");
    if (c.lang === "json") expect(() => JSON.parse(s)).not.toThrow();
  });
});
