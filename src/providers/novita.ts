// Novita Agent Sandbox: Novita's sandboxes speak E2B's API, so this adapter is the e2b one
// (`e2bCompatible`) pointed at Novita's domain. Novita's own SDK, npm `novita-sandbox`, is a fork
// of E2B's: its API is https://api.<domain> with the X-API-KEY header and each sandbox answers at
// <port>-<id>.<domain>, exactly as E2B's does; the default domain is us-phx-1.sandbox.novita.ai.
// Free: $100 of promotional credit after a short survey, no card; the free tier runs 5 sandboxes
// at once, up to 2 vCPU / 4 GiB, for 1 h each. Paid: $0.0000098 per vCPU-second and $0.0000032 per
// GiB-second while running. A sandbox's size comes from its template (set when the template is
// built), so the request's cpu and memory don't change it. Novita doesn't say how sandboxes are
// isolated. An empty balance answers 402 ("insufficient balance") and ends running sandboxes.
// Docs: https://docs.novita.ai/guides/sandbox-overview.md, sandbox-sdk-and-cli.md,
// sandbox-quota-limit.md, sandbox-pricing.md, sandbox-faq-insufficient-balance.md.
// SDK/CLI: npm `novita-sandbox`, `novita-sandbox-cli`.

import { e2bCompatible } from "./e2b-compatible.js";

export const NOVITA_DEFAULT_DOMAIN = "us-phx-1.sandbox.novita.ai";

export const novitaProvider = e2bCompatible({
  info: {
    id: "novita",
    name: "Novita Agent Sandbox",
    homepage: "https://novita.ai",
    env: ["NOVITA_API_KEY"],
    capabilities: ["ports", "pause", "fileList", "extendTimeout"],
    // Isolation is left unset: Novita does not publish it, so `minIsolation` requests skip it.
    maxTimeoutSec: 3 * 3600,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 100 },
      concurrency: 5,
      maxLifetimeSec: 3600,
      requiresCard: false,
      notes: "$100 of promotional credit once a short account survey is done, no card. Free tier: 5 concurrent, 1 h per session, up to 2 vCPU / 4 GiB.",
      source: "https://docs.novita.ai/guides/sandbox-pricing.md",
      checked: "2026-11-21",
    },
    pricing: { vcpuSecondUsd: 0.0000098, gibSecondUsd: 0.0000032, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://docs.novita.ai/guides/sandbox-pricing.md" },
    surfaces: { rest: `https://api.${NOVITA_DEFAULT_DOMAIN}`, sdk: ["novita-sandbox (npm)", "novita-sandbox (PyPI)", "e2b (npm, with Novita's domain)"], cli: "novita-sandbox-cli" },
  },
  connection: (ctx) => ({
    apiKey: ctx.env["NOVITA_API_KEY"],
    domain: ctx.env["NOVITA_DOMAIN"] ?? NOVITA_DEFAULT_DOMAIN,
    apiUrl: ctx.env["NOVITA_API_URL"],
  }),
  ports: true,
  setTimeout: true,
  pause: true,
  listAlive: true,
});
