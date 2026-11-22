import { describe, expect, it } from "vitest";
import { OTHER, OTHER_KEY, SERIES, seriesFor } from "@/lib/series";

describe("provider series", () => {
  it("colors by name, not by rank: the same providers get the same colors whatever their order", () => {
    const a = seriesFor(new Map([["modal", 5], ["e2b", 1]]));
    const b = seriesFor(new Map([["modal", 1], ["e2b", 5]]));
    expect(a.color("e2b")).toBe(b.color("e2b"));
    expect(a.color("e2b")).toBe(SERIES[0]);
  });

  it("folds providers past the seventh into Other", () => {
    const w = new Map(Array.from({ length: 9 }, (_, i) => [`p${i}`, 10 - i] as [string, number]));
    const s = seriesFor(w);
    expect(s.keys).toHaveLength(7);
    expect(s.keys.at(-1)).toBe(OTHER_KEY);
    expect(s.fold("p8")).toBe(OTHER_KEY);
    expect(s.color("p8")).toBe(OTHER);
  });
});
