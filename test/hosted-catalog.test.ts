// The hosted catalog against the adapters it lists: saving every required field makes the
// provider configured, no field moves an adapter to another host, and checks reject the rest.
import { describe, expect, it } from "vitest";
import { HOSTED_CATALOG, checkCredentials, credentialHints, hostedAdapters } from "../src/hosted/catalog.js";
import { checkHostedConfig, toRouterConfig } from "../src/hosted/config.js";
import { isConfigured } from "../src/core/routing/candidates.js";

describe("hosted catalog", () => {
  it("lists each provider once, in step with its adapter", () => {
    const ids = HOSTED_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(hostedAdapters().map((a) => a.info.id)).toEqual(ids);
    for (const a of hostedAdapters()) expect(a.info.selfHosted, a.info.id).toBeFalsy();
  });

  it("asks for every variable the adapter needs, so a saved provider counts as configured", () => {
    for (const [i, a] of hostedAdapters().entries()) {
      const entry = HOSTED_CATALOG[i]!;
      const names = entry.fields.map((f) => f.name);
      for (const v of a.info.env) expect(names, `${a.info.id} needs ${v}`).toContain(v);
      const env = Object.fromEntries(entry.fields.filter((f) => f.required).map((f) => [f.name, f.kind === "setting" ? "tea-abc" : "secret-value-1234"]));
      expect(isConfigured(a, { env, options: {} }), a.info.id).toBe(true);
    }
  });

  it("never takes a variable that names a host", () => {
    for (const e of HOSTED_CATALOG) {
      for (const f of e.fields) expect(f.name, `${e.id}.${f.name}`).not.toMatch(/URL|ENDPOINT|HOST|DOMAIN|SERVER|FILE|PATH|PROFILE|CREDENTIALS/);
    }
  });

  it("checks values: required, known, one line, and settings by pattern", () => {
    expect(checkCredentials("e2b", { E2B_API_KEY: " k " })).toEqual({ ok: true, values: { E2B_API_KEY: "k" } });
    expect(checkCredentials("e2b", { E2B_API_URL: "x", E2B_API_KEY: "k" })).toMatchObject({ ok: false });
    expect(checkCredentials("nope", {})).toMatchObject({ ok: false });
    expect(checkCredentials("render", { RENDER_API_KEY: "k", RENDER_WORKSPACE_ID: "tea-1 2" })).toMatchObject({ ok: false });
    expect(credentialHints("render", { RENDER_API_KEY: "rnd_0123456789", RENDER_WORKSPACE_ID: "tea-1" })).toEqual({ RENDER_API_KEY: "…6789", RENDER_WORKSPACE_ID: "tea-1" });
    expect(credentialHints("e2b", { E2B_API_KEY: "short" })).toEqual({ E2B_API_KEY: "…" });
  });

  it("takes a router config without server tokens, reporters, self-hosting or adapter options", () => {
    expect(checkHostedConfig({ routing: { strategy: "cheapest" } })).toMatchObject({ ok: true });
    expect(checkHostedConfig({ serverToken: "x" })).toMatchObject({ ok: false });
    expect(checkHostedConfig({ providers: { e2b: { options: {} } } })).toMatchObject({ ok: false });
    expect(toRouterConfig({}).selfHosted).toBe("never");
  });
});
