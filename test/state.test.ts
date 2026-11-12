import { describe, expect, it } from "vitest";
import { transition, effectiveState, InvalidTransitionError, type SandboxRecord } from "../src/core/state.js";
import { billableSeconds } from "../src/core/metering.js";

const T0 = Date.UTC(2026, 10, 11, 12);
const base: SandboxRecord = { id: "sbr_1", provider: "p", state: "creating", cpu: 1, memoryMiB: 1024, createdAt: new Date(T0).toISOString(), metadata: {} };
const ALL = { from: 0, to: Number.POSITIVE_INFINITY };

describe("sandbox lifecycle", () => {
  it("creating → running → stopped bills the time between", () => {
    const running = transition(base, { type: "created", providerSandboxId: "x", timeoutSec: 600 }, T0);
    const stopped = transition(running, { type: "stopped", reason: "killed" }, T0 + 120_000);
    expect(stopped.state).toBe("stopped");
    expect(billableSeconds(stopped, ALL, T0 + 999_999)).toBe(120);
  });

  it("a running sandbox past its deadline reads as expired and bills only up to the deadline", () => {
    const running = transition(base, { type: "created", providerSandboxId: "x", timeoutSec: 60 }, T0);
    expect(effectiveState(running, T0 + 59_000)).toBe("running");
    expect(effectiveState(running, T0 + 60_000)).toBe("expired");
    expect(billableSeconds(running, ALL, T0 + 3_600_000)).toBe(60);
    const stopped = transition(running, { type: "stopped", reason: "killed" }, T0 + 3_600_000);
    expect(stopped.state === "stopped" && stopped.reason).toBe("expired");
    expect(billableSeconds(stopped, ALL, T0 + 7_200_000)).toBe(60);
  });

  it("pause closes the billing segment and resume opens a new one", () => {
    let r = transition(base, { type: "created", providerSandboxId: "x", timeoutSec: 600 }, T0);
    r = transition(r, { type: "paused" }, T0 + 10_000);
    expect(billableSeconds(r, ALL, T0 + 500_000)).toBe(10);
    r = transition(r, { type: "resumed", timeoutSec: 600 }, T0 + 100_000);
    r = transition(r, { type: "stopped", reason: "killed" }, T0 + 105_000);
    expect(billableSeconds(r, ALL, T0 + 500_000)).toBe(15);
  });

  it("refuses moves the table does not allow", () => {
    expect(() => transition(base, { type: "paused" }, T0)).toThrow(InvalidTransitionError);
    const failed = transition(base, { type: "createFailed", error: "nope" }, T0);
    expect(() => transition(failed, { type: "created", providerSandboxId: "x", timeoutSec: 1 }, T0)).toThrow(InvalidTransitionError);
    const running = transition(base, { type: "created", providerSandboxId: "x", timeoutSec: 60 }, T0);
    // An expired sandbox cannot get its deadline moved: the provider already stopped it.
    expect(() => transition(running, { type: "timeoutSet", timeoutSec: 60 }, T0 + 61_000)).toThrow(InvalidTransitionError);
  });

  it("stop is idempotent", () => {
    const running = transition(base, { type: "created", providerSandboxId: "x", timeoutSec: 60 }, T0);
    const once = transition(running, { type: "stopped", reason: "killed" }, T0 + 1000);
    expect(transition(once, { type: "stopped", reason: "killed" }, T0 + 5000)).toBe(once);
  });
});
