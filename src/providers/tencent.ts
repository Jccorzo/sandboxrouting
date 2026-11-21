// Tencent Cloud Agent Sandbox (Agent Runtime, product 1814): sandboxes on Tencent's Cube secure
// sandbox, each with its own kernel. No free compute: 0.000081 CNY per vCPU-second and
// 0.000025 CNY per GiB-second while running, plus 15 GiB of system disk free per running
// instance. Converted at 7.1 CNY per USD.
// It speaks E2B's API: the stock `e2b` SDK with E2B_DOMAIN=<region>.tencentags.com and an API
// key made in the console. A sandbox is started from a "sandbox tool" made in the console
// first; the tool's name is the E2B template and fixes the size (Code Interpreter: 2 vCPU,
// 1000 MiB). Quotas per account and region: 50 instances, 50 vCPU, 100 GiB, 20 paused.
// Docs: https://cloud.tencent.com/document/product/1814/123816 (quick start, E2B migration),
// https://cloud.tencent.com/document/product/1814/133249 (billing),
// https://cloud.tencent.com/document/product/1814/123815 (quotas and tool sizes),
// https://cloud.tencent.com/document/product/1814/123813 (Cube, one kernel per sandbox).
// The docs show only create, run code and kill through the SDK, so pause, timeouts, URLs and
// listing are left out until they're confirmed against the service.

import { e2bCompatible } from "./e2b-compatible.js";

const CNY_PER_USD = 7.1;

export const tencentProvider = e2bCompatible({
  info: {
    id: "tencent",
    name: "Tencent Cloud Agent Sandbox",
    homepage: "https://cloud.tencent.com/document/product/1814",
    env: ["TENCENT_AGS_API_KEY", "TENCENT_AGS_TOOL"],
    capabilities: ["fileList"],
    isolation: "microvm",
    freeTier: {
      tier: { kind: "none" },
      concurrency: 50,
      notes: "Pay as you go. 15 GiB of system disk is free per running instance; CPU and memory are billed per second. Default quota: 50 instances per region.",
      source: "https://cloud.tencent.com/document/product/1814/133249",
      checked: "2026-11-21",
    },
    pricing: {
      vcpuSecondUsd: 0.000081 / CNY_PER_USD,
      gibSecondUsd: 0.000025 / CNY_PER_USD,
      defaultCpu: 2,
      defaultMemoryMiB: 1000,
      source: "https://cloud.tencent.com/document/product/1814/133249",
    },
    surfaces: { rest: "https://api.<region>.tencentags.com (E2B API)", sdk: ["e2b (npm), with E2B_DOMAIN=<region>.tencentags.com", "tencentcloud-sdk (StartSandboxInstance, TC3 signed)"] },
  },
  connection: (ctx) => ({
    apiKey: ctx.env["TENCENT_AGS_API_KEY"],
    domain: ctx.env["TENCENT_AGS_DOMAIN"] ?? `${ctx.env["TENCENT_AGS_REGION"] ?? "ap-guangzhou"}.tencentags.com`,
    apiUrl: ctx.env["TENCENT_AGS_API_URL"],
  }),
  template: (ctx) => ctx.env["TENCENT_AGS_TOOL"],
});
