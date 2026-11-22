// The Routing form writes its fields into the config as loaded and keeps everything else.
import { describe, expect, it } from "vitest";
import { configFromForm, formFromConfig } from "@/lib/routing-form";

describe("routing form", () => {
  const base = { routing: { strategy: "cheapest", weights: { speed: 2 } }, jobs: { leaseSec: 30 }, providers: { e2b: { priority: 5, pricing: { vcpuSecondUsd: 0.1 } } } };

  it("reads the loaded config, defaulting what isn't set", () => {
    expect(formFromConfig(base, ["e2b", "daytona"], "free-first")).toEqual({
      strategy: "cheapest",
      allowPaid: false,
      maxPaidUsdPerMonth: "",
      providers: { e2b: { enabled: true, priority: "5" }, daytona: { enabled: true, priority: "" } },
    });
    expect(formFromConfig({}, [], "free-first").strategy).toBe("free-first");
  });

  it("keeps fields the form doesn't show, and drops what it clears", () => {
    const form = formFromConfig(base, ["e2b", "daytona"], "free-first");
    form.allowPaid = true;
    form.maxPaidUsdPerMonth = "25";
    form.providers["e2b"] = { enabled: true, priority: "" };
    form.providers["daytona"] = { enabled: false, priority: "" };
    const out = configFromForm(base, form);
    expect(out).toEqual({
      ok: true,
      config: {
        routing: { strategy: "cheapest", weights: { speed: 2 } },
        jobs: { leaseSec: 30 },
        allowPaid: true,
        maxPaidUsdPerMonth: 25,
        providers: { e2b: { pricing: { vcpuSecondUsd: 0.1 } }, daytona: { enabled: false } },
      },
    });
    expect(base.providers.e2b.priority).toBe(5); // the loaded config isn't changed in place
  });

  it("refuses numbers that aren't", () => {
    const form = formFromConfig({}, ["e2b"], "free-first");
    expect(configFromForm({}, { ...form, maxPaidUsdPerMonth: "lots" })).toMatchObject({ ok: false });
    expect(configFromForm({}, { ...form, providers: { e2b: { enabled: true, priority: "x" } } })).toMatchObject({ ok: false });
  });
});
