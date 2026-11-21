// E2B: Firecracker microVMs. Free: $100 one-time credit (Hobby), 10 concurrent, 1 h max run.
// SDK: npm `e2b`. REST: https://api.e2b.app (X-API-Key). MCP: @e2b/mcp-server.

import { e2bCompatible } from "./e2b-compatible.js";

export const e2bProvider = e2bCompatible({
  info: {
    id: "e2b",
    name: "E2B",
    homepage: "https://e2b.dev",
    env: ["E2B_API_KEY"],
    capabilities: ["ports", "pause", "fileList", "extendTimeout", "snapshot"],
    isolation: "microvm",
    maxTimeoutSec: 24 * 3600,
    freeTier: {
      tier: { kind: "one-time-credit", usd: 100 },
      concurrency: 10,
      maxLifetimeSec: 3600,
      requiresCard: false,
      notes: "Hobby: $100 one-time credit, 10 concurrent, 1 h max continuous run.",
      source: "https://e2b.dev/pricing",
      checked: "2026-11-11",
    },
    pricing: { vcpuSecondUsd: 0.000014, gibSecondUsd: 0.0000045, defaultCpu: 2, defaultMemoryMiB: 512, source: "https://e2b.dev/pricing" },
    surfaces: { rest: "https://api.e2b.app", sdk: ["e2b (npm)", "e2b (PyPI)"], cli: "e2b", mcp: "@e2b/mcp-server" },
  },
  connection: (ctx) => ({ apiKey: ctx.env["E2B_API_KEY"] }),
  ports: true,
  setTimeout: true,
  pause: true,
  listAlive: true,
});
