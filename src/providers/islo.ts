// Islo (Incredibuild): "Machines", persistent microVMs, under a software-factory product. The
// sandbox API underneath is public. Plans only, no hourly rate: Engineer $20 a month (1 seat,
// unlimited Machines, usage limits Islo doesn't publish), Team $200 (10 seats, 10x the usage,
// trial up to $200), Enterprise custom. A plan's usage is modelled as included hours, and the
// paid price is the $20 plan spread over a month of one Machine (≈ $0.027/h); a plan limit or
// spent prepaid credit answers 402.
// Docs: https://docs.islo.dev/llms.txt, API reference https://docs.islo.dev/api-reference/sandboxes/
//   (create-sandbox, get-sandbox, delete-sandbox, exec-in-sandbox, get-exec-result, upload-file,
//   download-file, pause-sandbox, resume-sandbox, list-sandboxes), lifecycle
//   https://docs.islo.dev/concepts/sandbox-lifecycle.md, pricing https://islo.dev/pricing,
//   control-plane OpenAPI https://api.islo.dev/openapi.json. Auth from npm `@islo-labs/sdk` 0.0.38:
//   the API key is exchanged at POST https://api.islo.dev/auth/token for a session JWT.
// Compute plane: https://ca.compute.islo.dev (ISLO_COMPUTE_URL), sandboxes addressed by name.
// `lifecycle.delete_after` deletes the sandbox that long after creation, so Islo enforces the
// timeout. Exec is asynchronous: start, then read the result until it ends.

import { SandboxRouterError } from "../core/errors.js";
import { defineProvider, http, httpJson, HttpError, refusals } from "./util.js";
import { grantCache, pollMs, sbrName, shq, sleep } from "./rest-helpers.js";
import type { ProviderContext } from "../core/types.js";

const control = (ctx: ProviderContext) => String(ctx.env["ISLO_BASE_URL"] ?? "https://api.islo.dev").replace(/\/+$/, "");
const compute = (ctx: ProviderContext) => String(ctx.env["ISLO_COMPUTE_URL"] ?? "https://ca.compute.islo.dev").replace(/\/+$/, "");
const box = (ctx: ProviderContext, name: string, path = "") => `${compute(ctx)}/sandboxes/${encodeURIComponent(name)}${path}`;

/** Session JWTs per API key, refreshed a minute before they lapse. */
const sessions = grantCache<string>();
async function auth(ctx: ProviderContext): Promise<Record<string, string>> {
  const key = String(ctx.env["ISLO_API_KEY"]);
  const token = await sessions.get(`${control(ctx)} ${key}`, async () => {
    const r = await httpJson<{ session_token: string; cookie_max_age?: number }>(`${control(ctx)}/auth/token`, { body: { access_key: key }, timeoutMs: 10_000 });
    return { value: r.session_token, expiresAt: Date.now() + (r.cookie_max_age ?? 600) * 1000 };
  });
  return { authorization: `Bearer ${token}` };
}

/** Error codes that arrive with a status `classify` would read otherwise. */
const refused = refusals("islo", [
  { status: 400, body: /BILLING_NOT_ALLOWED/, kind: "quota", why: "billing refused" },
  { status: 400, body: /RATE_LIMITED/, kind: "rate_limit" },
  { status: 409, body: /RATE_LIMITED/, kind: "rate_limit" },
  { status: 409, body: /BILLING_NOT_ALLOWED/, kind: "quota", why: "billing refused" },
]);

interface Sandbox {
  id: string;
  name: string;
  status: string;
  spec?: { vcpus: number; memory_mb: number } | null;
}
interface ExecResult {
  status: string;
  stdout: string;
  stderr: string;
  exit_code?: number | null;
}

export const isloProvider = defineProvider({
  info: {
    id: "islo",
    name: "Islo Machines",
    homepage: "https://islo.dev",
    env: ["ISLO_API_KEY"],
    capabilities: ["pause", "customImage"],
    isolation: "microvm",
    freeTier: {
      // One Machine all month; the plan's real usage limit isn't published.
      tier: { kind: "monthly-hours", hours: 744 },
      requiresCard: true,
      notes:
        "No free plan: Engineer is $20 a month (1 seat, unlimited Machines, unpublished usage limits; a limit answers 402). Team $200 a month with a trial of up to $200. Counted here as one Machine's month of hours included in the plan; set it to what your plan allows.",
      source: "https://islo.dev/pricing",
      checked: "2026-11-21",
    },
    // $20 a month over 744 h at the default 2 vCPU / 4 GiB, split 2:1 vCPU:GiB.
    pricing: { vcpuSecondUsd: ((20 / 744) * 2) / 3 / 2 / 3600, gibSecondUsd: 20 / 744 / 3 / 4 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://islo.dev/pricing" },
    surfaces: { rest: "https://ca.compute.islo.dev", sdk: ["@islo-labs/sdk (npm)", "islo (PyPI)"], cli: "islo", mcp: "https://docs.islo.dev/_mcp/server (docs)" },
  },

  async create(spec, ctx) {
    const name = sbrName(spec);
    const headers = await auth(ctx);
    let s: Sandbox;
    try {
      s = await httpJson<Sandbox>(`${compute(ctx)}/sandboxes`, {
        headers,
        body: {
          name,
          request_id: spec.metadata["sandboxrouting.id"],
          image: spec.image ?? spec.nativeTemplate ?? String(ctx.options["image"] ?? "ubuntu:22.04"),
          vcpus: spec.cpu ? Math.max(1, Math.round(spec.cpu)) : undefined,
          memory_mb: spec.memoryMiB ? Math.round(spec.memoryMiB) : undefined,
          env: Object.keys(spec.env).length ? spec.env : undefined,
          lifecycle: { delete_after: Math.max(1, Math.ceil(spec.timeoutSec)), auto_resume: "never" },
        },
        timeoutMs: 300_000,
      });
    } catch (err) {
      // A retried create whose first try went through: that sandbox is this one.
      if (err instanceof HttpError && err.status === 409 && /SANDBOX_ALREADY_EXISTS/.test(err.message)) {
        s = await httpJson<Sandbox>(box(ctx, name), { headers });
      } else throw refused(err);
    }
    try {
      for (let i = 0; i < 300 && s.status !== "running"; i++) {
        if (/fail|error|delet|stopp/i.test(s.status)) throw new Error(`islo sandbox ${name} is ${s.status}`);
        await sleep(pollMs(ctx, 1000));
        s = await httpJson<Sandbox>(box(ctx, name), { headers: await auth(ctx) });
      }
      if (s.status !== "running") throw new Error(`islo sandbox ${name} did not start (${s.status})`);
    } catch (err) {
      await this.kill(name, ctx).catch(() => undefined);
      throw err;
    }
    return { providerSandboxId: s.name, cpu: s.spec?.vcpus, memoryMiB: s.spec?.memory_mb };
  },

  async exec(id, command, o, ctx) {
    const timeoutSec = Math.max(1, Math.ceil(o.timeoutSec ?? 600));
    // timeout_secs is only a hint, so `timeout` ends the command; 124 is its exit when it does.
    const started = await httpJson<{ exec_id: string }>(box(ctx, id, "/exec"), {
      headers: await auth(ctx),
      body: { command: ["sh", "-c", `timeout ${timeoutSec} sh -c ${shq(command)}`], env: o.env, workdir: o.cwd, timeout_secs: timeoutSec },
    });
    const deadline = Date.now() + (timeoutSec + 60) * 1000;
    let r: ExecResult;
    for (;;) {
      r = await httpJson<ExecResult>(box(ctx, id, `/exec/${encodeURIComponent(started.exec_id)}`), { headers: await auth(ctx) });
      if (r.exit_code !== undefined && r.exit_code !== null) break;
      if (!/run|pend|start|queue/i.test(r.status)) break;
      if (Date.now() > deadline) throw new SandboxRouterError("transient", `islo: command ${started.exec_id} still running after ${timeoutSec} s`, "islo");
      await sleep(pollMs(ctx, 500));
    }
    if (r.stdout) o.onStdout?.(r.stdout);
    if (r.stderr) o.onStderr?.(r.stderr);
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exit_code ?? 1 };
  },

  async readFile(id, path, ctx) {
    const res = await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { headers: await auth(ctx), timeoutMs: 300_000 });
    return new Uint8Array(await res.arrayBuffer());
  },

  async writeFile(id, path, data, ctx) {
    const form = new FormData();
    form.append("file", new Blob([Buffer.from(data)]), path.split("/").pop() || "file");
    await http(`${box(ctx, id, "/files")}?path=${encodeURIComponent(path)}`, { method: "POST", headers: await auth(ctx), raw: form, timeoutMs: 300_000 });
  },

  async pause(id, ctx) {
    await http(box(ctx, id, "/pause"), { method: "POST", headers: await auth(ctx) });
  },

  async resume(id, ctx) {
    try {
      await http(box(ctx, id, "/resume"), { method: "POST", headers: await auth(ctx) });
    } catch (err) {
      throw refused(err);
    }
  },

  async kill(id, ctx) {
    try {
      await http(box(ctx, id), { method: "DELETE", headers: await auth(ctx) });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return;
      throw err;
    }
  },

  async listAlive(ctx) {
    const names: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await httpJson<{ items: (Sandbox & { deleted_at?: string | null })[]; next_cursor?: string | null }>(
        `${compute(ctx)}/sandboxes?name_prefix=sbr-${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers: await auth(ctx) },
      );
      for (const s of page.items) if (!s.deleted_at && !/delet|fail|error/i.test(s.status)) names.push(s.name);
      cursor = page.next_cursor;
    } while (cursor);
    return names;
  },
});
