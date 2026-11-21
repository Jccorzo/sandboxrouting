// Volcengine AgentKit sandbox templates: microVMs on veFaaS. No free tier: 0.0000405 CNY per
// vCPU-second and 0.0000102 CNY per GB-second, plus 0.8 CNY per GB of outbound traffic.
// Converted at 7.1 CNY per USD.
// A template made in the AgentKit console with "E2B protocol compatible" turned on is driven by
// the stock `e2b` SDK: E2B_API_URL=https://api.vefaas-e2b.sandbox-<region>.volcapig.com
// (cn-beijing or cn-shanghai), an `e2b_apikey_…` key and the template's id. The template fixes
// the image and size. veFaaS has no `/v2/sandboxes/{id}/connect`, so a sandbox is reachable
// only from the process that created it, and a paused one can't be resumed through the SDK.
// Listing needs the template id, sent as the `vefaas_function_id` metadata filter.
// Docs: https://docs.volcengine.com/docs/agentkit/e2b-sdk-cli-integration-practice (E2B setup,
// limits), https://docs.volcengine.com/docs/agentkit/billing-items (prices),
// https://docs.volcengine.com/docs/agentkit/tool-overview (microVM),
// https://docs.volcengine.com/docs/agentkit/create-manage-e2b-api-key (keys).

import { e2bCompatible } from "./e2b-compatible.js";

const CNY_PER_USD = 7.1;
const apiUrl = (env: Record<string, string | undefined>) =>
  env["VOLCENGINE_E2B_API_URL"] ?? `https://api.vefaas-e2b.sandbox-${env["VOLCENGINE_E2B_REGION"] ?? "cn-beijing"}.volcapig.com`;

export const volcengineProvider = e2bCompatible({
  info: {
    id: "volcengine",
    name: "Volcengine AgentKit Sandbox",
    homepage: "https://www.volcengine.com/product/agentkit",
    env: ["VOLCENGINE_E2B_API_KEY", "VOLCENGINE_E2B_TEMPLATE_ID"],
    capabilities: ["fileList"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "none" },
      notes: "Pay as you go: CPU and memory per second, outbound traffic per GB. The free Runtime/MCP quota doesn't cover sandboxes.",
      source: "https://docs.volcengine.com/docs/agentkit/billing-items",
      checked: "2026-11-21",
    },
    pricing: {
      vcpuSecondUsd: 0.0000405 / CNY_PER_USD,
      gibSecondUsd: 0.0000102 / CNY_PER_USD,
      defaultCpu: 2,
      defaultMemoryMiB: 4096,
      source: "https://docs.volcengine.com/docs/agentkit/billing-items",
    },
    surfaces: {
      rest: "https://api.vefaas-e2b.sandbox-<region>.volcapig.com (E2B API)",
      sdk: ["e2b (npm), with E2B_API_URL set to the region's endpoint", "agentkit-sdk-python"],
      cli: "e2b, agentkit",
    },
  },
  connection: (ctx) => ({ apiKey: ctx.env["VOLCENGINE_E2B_API_KEY"], apiUrl: apiUrl(ctx.env), domain: ctx.env["VOLCENGINE_E2B_DOMAIN"] }),
  template: (ctx) => ctx.env["VOLCENGINE_E2B_TEMPLATE_ID"],
  reconnect: false,
  listAlive: (ctx) => ({ vefaas_function_id: String(ctx.env["VOLCENGINE_E2B_TEMPLATE_ID"]) }),
});
