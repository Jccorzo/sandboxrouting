// The polled view's state machine: a stale answer never overwrites a newer one, a failed
// refresh keeps the old data marked stale, and a new query starts from loading.
import { describe, expect, it } from "vitest";
import { initialPoll, pollReducer, type PollState } from "@/lib/poll-state";

type S = PollState<string>;
const run = (actions: Parameters<typeof pollReducer<string>>[1][], from: S = initialPoll<string>()) => actions.reduce((s, a) => pollReducer(s, a), from);
const net = { kind: "network" as const, message: "down" };

describe("poll state", () => {
  it("drops the answer of an older request that arrives after a newer one began", () => {
    const s = run([
      { type: "begin", gen: 1 },
      { type: "begin", gen: 2 },
      { type: "succeeded", gen: 2, data: "new", at: 2 },
      { type: "succeeded", gen: 1, data: "old", at: 3 },
    ]);
    expect(s.view).toMatchObject({ status: "ready", data: "new" });
  });

  it("drops an older request's failure too", () => {
    const s = run([
      { type: "begin", gen: 1 },
      { type: "begin", gen: 2 },
      { type: "succeeded", gen: 2, data: "fresh", at: 1 },
      { type: "failed", gen: 1, failure: net },
    ]);
    expect(s.view).toEqual({ status: "ready", data: "fresh", fetchedAt: 1, refreshing: false });
  });

  it("keeps the last data, marked stale, when a refresh fails, and clears the mark when one works", () => {
    let s = run([
      { type: "begin", gen: 1 },
      { type: "succeeded", gen: 1, data: "a", at: 10 },
      { type: "begin", gen: 2 },
    ]);
    expect(s.view).toMatchObject({ status: "ready", refreshing: true });
    s = run([{ type: "failed", gen: 2, failure: net }], s);
    expect(s.view).toEqual({ status: "ready", data: "a", fetchedAt: 10, refreshing: false, failure: net });
    s = run(
      [
        { type: "begin", gen: 3 },
        { type: "succeeded", gen: 3, data: "b", at: 30 },
      ],
      s,
    );
    expect(s.view).toEqual({ status: "ready", data: "b", fetchedAt: 30, refreshing: false });
  });

  it("shows an error with nothing to fall back on, and a retry that works replaces it", () => {
    let s = run([
      { type: "begin", gen: 1 },
      { type: "failed", gen: 1, failure: net },
    ]);
    expect(s.view).toEqual({ status: "error", failure: net, retrying: false });
    s = run([{ type: "begin", gen: 2 }], s);
    expect(s.view).toMatchObject({ status: "error", retrying: true });
    s = run([{ type: "succeeded", gen: 2, data: "ok", at: 5 }], s);
    expect(s.view).toMatchObject({ status: "ready", data: "ok" });
  });

  it("a reset (the query changed) starts from loading and ignores answers to the old query", () => {
    const s = run([
      { type: "begin", gen: 1 },
      { type: "succeeded", gen: 1, data: "30 days", at: 1 },
      { type: "begin", gen: 2 },
      { type: "reset", gen: 3 },
      { type: "succeeded", gen: 2, data: "late 30 days", at: 2 },
    ]);
    expect(s.view).toEqual({ status: "loading" });
  });
});
