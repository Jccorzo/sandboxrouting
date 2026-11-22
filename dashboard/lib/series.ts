// Provider colors for charts. The categorical palette is validated for colorblind separation in
// this order (dataviz reference palette, checked on white); a provider keeps its color across
// charts and ranges because slots go by name, not by rank. Past seven providers the rest fold
// into "Other".

export const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6"] as const;
export const OTHER = "#a9a8a2";
export const OTHER_KEY = "Other";

/**
 * Which providers get their own series (the biggest by `weight`, at most seven) and the color
 * of each. Slots are handed out in alphabetical order among those shown, so the same set of
 * providers always gets the same colors.
 */
export function seriesFor(weights: Map<string, number>, max = SERIES.length): { keys: string[]; color: (k: string) => string; fold: (k: string) => string } {
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const needsOther = ranked.length > max;
  const shown = ranked.slice(0, needsOther ? max - 1 : max).map(([k]) => k).sort((a, b) => a.localeCompare(b));
  const colors = new Map(shown.map((k, i) => [k, SERIES[i]!]));
  const keys = needsOther ? [...shown, OTHER_KEY] : shown;
  return {
    keys,
    color: (k) => colors.get(k) ?? OTHER,
    fold: (k) => (colors.has(k) ? k : OTHER_KEY),
  };
}
