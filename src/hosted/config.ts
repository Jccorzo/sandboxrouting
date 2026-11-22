// An account's routing config on the hosted router: the router's own config (strategy, paid
// usage, budgets, per-provider switches and prices), minus what only makes sense on someone's
// own machine or would reach past their account: a server token, a reporter, self-hosted
// providers, and adapter options (some name a URL to call).
//
// The config is stored as the person wrote it, so defaults can improve later; toRouterConfig is
// the one place that turns it into what the router runs with.

import { parseConfig, type RouterConfig } from "../core/config.js";
import { catalogEntry } from "./catalog.js";

export type HostedConfigCheck = { ok: true; config: Record<string, unknown> } | { ok: false; message: string };

const NOT_HOSTED = ["serverToken", "report"] as const;

export function checkHostedConfig(input: unknown): HostedConfigCheck {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "the config must be an object" };
  const config = input as Record<string, unknown>;
  for (const k of NOT_HOSTED) {
    if (k in config) return { ok: false, message: `${k} isn't used on the hosted router` };
  }
  if ("selfHosted" in config && config["selfHosted"] !== "never") return { ok: false, message: "the hosted router has no self-hosted providers: leave selfHosted out" };
  const providers = config["providers"];
  if (providers !== undefined) {
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) return { ok: false, message: "providers must be an object" };
    for (const [id, p] of Object.entries(providers as Record<string, unknown>)) {
      if (!catalogEntry(id)) return { ok: false, message: `${id} isn't a provider the hosted router runs` };
      if (p && typeof p === "object" && "options" in p) return { ok: false, message: `providers.${id}.options isn't used on the hosted router` };
    }
  }
  try {
    parseConfig(config);
  } catch (err) {
    const issue = (err as { issues?: { path: (string | number)[]; message: string }[] }).issues?.[0];
    return { ok: false, message: issue ? `${issue.path.join(".") || "config"}: ${issue.message}` : "that config isn't valid" };
  }
  if (JSON.stringify(config).length > 64 * 1024) return { ok: false, message: "the config may be at most 64 KiB" };
  return { ok: true, config };
}

/** What the hosted router runs with for a stored config. */
export function toRouterConfig(stored: Record<string, unknown>): RouterConfig {
  const { serverToken: _t, report: _r, ...rest } = stored;
  return parseConfig({ ...rest, selfHosted: "never" });
}
