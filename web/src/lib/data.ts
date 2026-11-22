// Typed access to what scripts/generate.ts wrote from the router. Pages read providers and
// examples only through here; nothing on the site restates a provider's terms by hand.

import providersJson from "@/generated/providers.json";
import siteJson from "@/generated/site.json";
import defaultPlanJson from "@/generated/default-plan.json";
import { CATEGORY_ORDER, type Category, type PlanGridEntry, type ProviderDoc, type SiteData } from "./generated-types";

export const providers = providersJson as unknown as ProviderDoc[];
export const site = siteJson as unknown as SiteData;
export const defaultPlan = defaultPlanJson as unknown as PlanGridEntry;

const byId = new Map(providers.map((p) => [p.id, p]));

export function provider(id: string): ProviderDoc {
  const p = byId.get(id);
  if (!p) throw new Error(`unknown provider "${id}"`);
  return p;
}

export function maybeProvider(id: string): ProviderDoc | undefined {
  return byId.get(id);
}

export function providersIn(category: Category): ProviderDoc[] {
  return providers.filter((p) => p.category === category);
}

export function sortedProviders(): ProviderDoc[] {
  return [...providers].sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name));
}

/** Provider id → display name, for client components that shouldn't ship the whole list. */
export function providerNames(): Record<string, string> {
  return Object.fromEntries(providers.map((p) => [p.id, p.name]));
}

export * from "./format";
