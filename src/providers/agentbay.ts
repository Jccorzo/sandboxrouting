// Alibaba Cloud AgentBay (Wuying): cloud sessions for agents, from images such as
// `code_latest` (Linux with a shell tool) or `linux_latest`. Basic plan: free, 10 concurrent
// sessions and 100 GiB of storage, but compute is still billed: $0.027 per core-hour and
// $0.0113 per GB-hour, per second.
// API: Alibaba Cloud OpenAPI in RPC style, product version 2025-05-06, at
// https://agentbay.<region>.aliyuncs.com (cn-hangzhou, ap-southeast-1, us-east-1). Calls are
// anonymous to the gateway: the AgentBay API key goes in the form body as
// `Authorization: Bearer akm-…`, so no AccessKey signature is needed. A call can fail inside
// a 200 with `Success: false` and a `Code`. Commands run through the `shell` MCP tool
// (CallMcpTool), which waits 50 s at most. Its file tools are text-only, so files use the
// router's exec fallback. No idempotency key: the router's id goes in the session's labels.
// Docs: https://www.alibabacloud.com/help/en/agentbay/product-overview/agentbay-billing-instructions
// (prices), https://help.aliyun.com/zh/agentbay/developer-reference/sdk-access-guide (keys,
// regions); the request shapes are taken from the official SDK,
// https://github.com/agentbay-ai/wuying-agentbay-sdk (typescript/src/api/client.ts,
// agent-bay.ts, session.ts, command/command.ts).

import { randomUUID } from "node:crypto";
import { defineProvider, http, HttpError } from "./util.js";
import { inline, pollMs, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const VERSION = "2025-05-06";
const EXEC_LIMIT_SEC = 50;

const base = (ctx: ProviderContext) =>
  String(ctx.env["AGENTBAY_API_URL"] ?? `https://agentbay.${ctx.env["AGENTBAY_REGION"] ?? "cn-hangzhou"}.aliyuncs.com`).replace(/\/+$/, "");

interface Reply<T> {
  Code?: string;
  Message?: string;
  Success?: boolean;
  HttpStatusCode?: number;
  RequestId?: string;
  NextToken?: string;
  Data?: T;
}

/** One RPC call. A refusal inside a 200 is raised with its own status so the router can classify it. */
async function rpc<T>(ctx: ProviderContext, action: string, params: Record<string, string | number | boolean | undefined>): Promise<Reply<T>> {
  const query = new URLSearchParams({ Action: action, Format: "json", Version: VERSION, Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), SignatureNonce: randomUUID() });
  const form = new URLSearchParams({ Authorization: `Bearer ${ctx.env["AGENTBAY_API_KEY"]}` });
  for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, String(v));
  const res = await http(`${base(ctx)}/?${query}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-acs-action": action, "x-acs-version": VERSION },
    raw: form.toString(),
  }).catch((err: unknown) => {
    // The gateway may answer a bad key with a 400 whose body says 401: the body wins.
    const said = err instanceof HttpError ? Number(/"HttpStatusCode"\s*:\s*(\d{3})/.exec(err.message)?.[1]) : NaN;
    throw said >= 400 && said !== (err as HttpError).status ? new HttpError(said, (err as HttpError).message) : err;
  });
  const text = await res.text();
  const body = (text ? JSON.parse(text) : {}) as Reply<T>;
  if (body.Success === false) {
    const status = body.HttpStatusCode && body.HttpStatusCode >= 400 ? body.HttpStatusCode : 400;
    throw new HttpError(status, `${action}: [${body.Code ?? "Error"}] ${body.Message ?? ""}`.trim());
  }
  return body;
}
const call = async <T>(ctx: ProviderContext, action: string, params: Record<string, string | number | boolean | undefined>) => (await rpc<T>(ctx, action, params)).Data;

const isGone = (err: unknown) => (err instanceof HttpError && err.status === 404) || /NotFound|not found/i.test(String((err as Error)?.message));

interface Session {
  SessionId?: string;
  Status?: string;
  Success?: boolean;
  ErrMsg?: string;
}
const DEAD = /fail|finish|delet|release/i;

/** The shell tool's reply: `{exit_code, stdout, stderr}` from `code_latest`, raw stdout from other images. */
function shellPayload(text: string): { stdout: string; stderr: string; exitCode?: number } {
  try {
    const p = JSON.parse(text) as { exit_code?: unknown; stdout?: unknown; stderr?: unknown };
    const out = typeof p.stdout === "string";
    const err = typeof p.stderr === "string";
    if (p && typeof p === "object" && ((Number.isInteger(p.exit_code) && (out || err)) || (out && err))) {
      return { stdout: out ? (p.stdout as string) : "", stderr: err ? (p.stderr as string) : "", exitCode: Number.isInteger(p.exit_code) ? (p.exit_code as number) : undefined };
    }
  } catch {
    // Not JSON: plain output.
  }
  return { stdout: text, stderr: "" };
}

export const agentbayProvider = defineProvider({
  info: {
    id: "agentbay",
    name: "Alibaba Cloud AgentBay",
    homepage: "https://www.alibabacloud.com/product/agentbay",
    env: ["AGENTBAY_API_KEY"],
    capabilities: [],
    // AgentBay doesn't say how sessions are isolated, so `minIsolation` requests skip it.
    maxExecSec: EXEC_LIMIT_SEC,
    freeTier: {
      tier: { kind: "none" },
      concurrency: 10,
      notes: "The Basic plan is free (10 concurrent sessions, 100 GiB storage), but CPU and memory are billed pay-as-you-go from the first second.",
      source: "https://www.alibabacloud.com/help/en/agentbay/product-overview/agentbay-billing-instructions",
      checked: "2026-11-21",
    },
    pricing: {
      vcpuSecondUsd: 0.027 / 3600,
      gibSecondUsd: 0.0113 / 3600,
      defaultCpu: 2,
      defaultMemoryMiB: 4096,
      source: "https://www.alibabacloud.com/help/en/agentbay/product-overview/agentbay-billing-instructions",
    },
    surfaces: {
      rest: "https://agentbay.<region>.aliyuncs.com (OpenAPI RPC, version 2025-05-06)",
      sdk: ["wuying-agentbay-sdk (npm)", "wuying-agentbay-sdk (PyPI)"],
      mcp: "https://agentbay.wuying.aliyuncs.com/v2/mcp",
    },
  },

  async create(spec, ctx) {
    // Lifetimes are whole minutes. The idle timer is set to the whole lifetime (3 min at least),
    // so a quiet sandbox isn't released before its deadline.
    const minutes = Math.max(1, Math.ceil(spec.timeoutSec / 60));
    const data = await call<Session>(ctx, "CreateMcpSession", {
      ImageId: spec.nativeTemplate ?? String(ctx.env["AGENTBAY_IMAGE_ID"] ?? ctx.options["imageId"] ?? "code_latest"),
      Labels: JSON.stringify(spec.metadata),
      Timeout: Math.max(3, minutes),
      MaxRuntime: minutes,
      LoginRegionId: ctx.env["AGENTBAY_REGION"],
    });
    const id = data?.SessionId;
    if (data?.Success === false || !id) throw new Error(`agentbay CreateMcpSession: ${data?.ErrMsg ?? "no session id"}`);
    try {
      let status = data.Status ?? "";
      for (let i = 0; i < 300 && status !== "RUNNING"; i++) {
        if (DEAD.test(status)) throw new Error(`agentbay session ${id} is ${status}`);
        if (i > 0) await sleep(pollMs(ctx, 1000));
        status = (await call<Session>(ctx, "GetSession", { SessionId: id }))?.Status ?? "";
      }
      if (status !== "RUNNING") throw new Error(`agentbay session ${id} did not start`);
    } catch (err) {
      await call(ctx, "DeleteSessionAsync", { SessionId: id }).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: id };
  },

  async exec(id, command, o, ctx) {
    const timeoutMs = Math.min(EXEC_LIMIT_SEC, Math.max(1, o.timeoutSec ?? EXEC_LIMIT_SEC)) * 1000;
    const data = await call<{ content?: { text?: string }[]; isError?: boolean } | string>(ctx, "CallMcpTool", {
      SessionId: id,
      Name: "shell",
      Args: JSON.stringify({ command: inline(command, { env: o.env }), timeout_ms: timeoutMs, ...(o.cwd ? { cwd: o.cwd } : {}) }),
      AutoGenSession: false,
    });
    const r = typeof data === "string" ? (JSON.parse(data) as { content?: { text?: string }[]; isError?: boolean }) : data ?? {};
    const text = (r.content ?? []).map((c) => c.text ?? "").join("");
    const p = shellPayload(text);
    let exitCode = p.exitCode ?? 0;
    let stderr = p.stderr;
    if (r.isError) {
      if (!exitCode) exitCode = /timeout/i.test(text) ? 124 : 1;
      if (p.exitCode === undefined) stderr = text;
    }
    const stdout = r.isError && p.exitCode === undefined ? "" : p.stdout;
    if (stdout) o.onStdout?.(stdout);
    if (stderr) o.onStderr?.(stderr);
    return { stdout, stderr, exitCode };
  },

  async kill(id, ctx) {
    try {
      await call(ctx, "DeleteSessionAsync", { SessionId: id });
    } catch (err) {
      if (!isGone(err)) throw err;
    }
  },

  async listAlive(ctx) {
    const ids: string[] = [];
    let next: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = await rpc<{ SessionId?: string; SessionStatus?: string }[]>(ctx, "ListSession", { MaxResults: 100, NextToken: next });
      for (const s of r.Data ?? []) if (s.SessionId && !DEAD.test(s.SessionStatus ?? "")) ids.push(s.SessionId);
      next = r.NextToken;
      if (!next) break;
    }
    return ids;
  },
});
