#!/usr/bin/env node
// sbr: the router from a terminal. Same operations as the SDK, REST API and MCP server.

import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { createRouter, type SandboxRouter } from "./core/router.js";
import { NoProviderAvailableError, classify } from "./core/errors.js";
import type { FreeStatus } from "./core/metering.js";
import type { Capability, SandboxSpec } from "./core/types.js";

const HELP = `sbr: one router for every sandbox provider, free tiers first

Usage:
  sbr providers [--refresh]          free-tier status and availability of every provider
  sbr route [spec flags]             which provider a new sandbox would go to, and why
  sbr create [spec flags]            create a sandbox; prints its id
  sbr run [spec flags] -- <command>  create, run one command, kill (exit code passes through)
  sbr exec <id> -- <command>         run a command in a sandbox
  sbr ls [--all]                     sandboxes the router created
  sbr read <id> <path> [--out file]  read a file
  sbr write <id> <path> [--in file]  write a file (stdin if --in is omitted)
  sbr files <id> [path]              list a directory
  sbr url <id> <port>                public URL for a port
  sbr extend <id> <seconds>          keep it alive this long from now
  sbr pause|resume|kill <id>
  sbr check [--provider <id>]        live end-to-end check (create, exec, files, kill) on every
                                     configured provider; paid-only ones only when named
  sbr sweep                          reconcile with providers (close what's gone)
  sbr reset <provider>               clear quota/rate-limit/auth marks on a provider
  sbr serve [--port 8787]            REST API
  sbr mcp                            MCP server over stdio

Spec flags:
  --provider <id>   (repeatable) only these    --exclude <id>  (repeatable)
  --image <ref>     OCI image                  --template <provider>=<name>
  --cpu <n>  --memory <MiB>  --timeout <sec>   --env KEY=VALUE (repeatable)
  --needs <cap>     ports|pause|customImage|gpu|snapshot|fileList|extendTimeout
  --json            machine-readable output

Paid usage is off unless sandboxrouting.json sets "allowPaid": true (or SBR_ALLOW_PAID=1).`;

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const before = dash >= 0 ? argv.slice(0, dash) : argv;
const after = dash >= 0 ? argv.slice(dash + 1) : [];

const { values, positionals } = parseArgs({
  args: before,
  allowPositionals: true,
  options: {
    provider: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
    image: { type: "string" },
    template: { type: "string", multiple: true },
    cpu: { type: "string" },
    memory: { type: "string" },
    timeout: { type: "string" },
    env: { type: "string", multiple: true },
    needs: { type: "string", multiple: true },
    json: { type: "boolean" },
    all: { type: "boolean" },
    refresh: { type: "boolean" },
    out: { type: "string" },
    in: { type: "string" },
    port: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const out = (v: unknown) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

function spec(): SandboxSpec {
  const kv = (list: string[] | undefined) =>
    Object.fromEntries(
      (list ?? []).map((s) => {
        const i = s.indexOf("=");
        if (i < 1) throw new Error(`expected KEY=VALUE, got "${s}"`);
        return [s.slice(0, i), s.slice(i + 1)];
      }),
    );
  return {
    providers: values.provider,
    exclude: values.exclude,
    image: values.image,
    template: values.template ? kv(values.template) : undefined,
    cpu: values.cpu ? Number(values.cpu) : undefined,
    memoryMiB: values.memory ? Number(values.memory) : undefined,
    timeoutSec: values.timeout ? Number(values.timeout) : undefined,
    env: values.env ? kv(values.env) : undefined,
    needs: values.needs as Capability[] | undefined,
  };
}

function freeText(f: FreeStatus): string {
  switch (f.state) {
    case "unlimited":
      return "unlimited (your hardware)";
    case "none":
      return "no free tier";
    case "exhausted":
      return `used up${f.resetsAt ? ` until ${new Date(f.resetsAt).toISOString().slice(0, 10)}` : ""}`;
    case "available": {
      const left = f.unit === "usd" ? `$${f.remaining.toFixed(2)}` : `${f.remaining.toFixed(1)} h`;
      const reset = f.resetsAt ? `, resets ${new Date(f.resetsAt).toISOString().slice(0, 10)}` : ", one-time";
      return `${left} left (${Math.round(f.fraction * 100)}%${reset})`;
    }
  }
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd()).join("\n");
}

const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Error(`missing ${what}; see sbr --help`);
  return v;
};

async function main(router: SandboxRouter): Promise<number> {
  const [cmd, a1, a2] = positionals;
  switch (cmd) {
    case "providers": {
      const status = await router.status({ refreshUsage: values.refresh });
      if (values.json) return out(status), 0;
      const rows = [["PROVIDER", "READY", "FREE TIER", "LIVE", "NOTE"]];
      for (const s of status) {
        const ready = !s.enabled ? "disabled" : !s.configured ? "no key" : !s.availability.ok ? s.availability.kind : "yes";
        const note = !s.configured ? `set ${s.missingEnv.join(", ")}` : s.freeTierNotes ?? "";
        rows.push([s.id, ready, freeText(s.free), `${s.live}${s.concurrency ? `/${s.concurrency}` : ""}`, note]);
      }
      out(table(rows));
      out(`\npaid usage: ${router.config.allowPaid ? "allowed" : "off (free tiers only)"} · policy: ${router.config.policy}`);
      return 0;
    }
    case "route": {
      const p = await router.plan(spec());
      if (values.json) return out(p), 0;
      p.ordered.forEach((e, i) => out(`${i + 1}. ${e.provider}  [${e.lane}]  ${freeText(e.free)}  ~$${(e.ratePerSecondUsd * 3600).toFixed(4)}/h`));
      if (!p.ordered.length) out("no provider can take this request");
      for (const s of p.skipped) out(`   - ${s.provider}: ${s.reason}`);
      return p.ordered.length ? 0 : 1;
    }
    case "create": {
      const sbx = await router.create(spec());
      if (values.json) return out({ ...(await sbx.info()), route: sbx.route }), 0;
      out(sbx.id);
      console.error(`created on ${sbx.provider} (${sbx.providerSandboxId})`);
      return 0;
    }
    case "run": {
      if (!after.length) throw new Error("usage: sbr run [spec flags] -- <command>");
      const sbx = await router.create(spec());
      console.error(`[sbr] ${sbx.provider} ${sbx.id}`);
      try {
        const r = await sbx.commands.run(after.join(" "), {
          onStdout: (s) => process.stdout.write(s),
          onStderr: (s) => process.stderr.write(s),
        });
        return r.exitCode;
      } finally {
        await sbx.kill().catch((e) => console.error(`[sbr] kill failed: ${(e as Error).message}`));
      }
    }
    case "exec": {
      if (!after.length) throw new Error("usage: sbr exec <id> -- <command>");
      const sbx = await router.connect(need(a1, "sandbox id"));
      const r = await sbx.commands.run(after.join(" "), {
        onStdout: (s) => process.stdout.write(s),
        onStderr: (s) => process.stderr.write(s),
      });
      return r.exitCode;
    }
    case "ls": {
      const list = await router.list({ all: values.all });
      if (values.json) return out(list), 0;
      const rows = [["ID", "PROVIDER", "STATE", "CREATED", "COST"]];
      for (const s of list) rows.push([s.id, s.provider, s.state, s.createdAt.slice(0, 19), `$${s.costUsd.toFixed(4)}`]);
      out(list.length ? table(rows) : "no sandboxes");
      return 0;
    }
    case "read": {
      const data = await (await router.connect(need(a1, "sandbox id"))).files.readBytes(need(a2, "path"));
      if (values.out) await writeFile(values.out, data);
      else process.stdout.write(data);
      return 0;
    }
    case "write": {
      const data = values.in ? await readFile(values.in) : await readStdin();
      await (await router.connect(need(a1, "sandbox id"))).files.write(need(a2, "path"), new Uint8Array(data));
      return 0;
    }
    case "files": {
      const items = await (await router.connect(need(a1, "sandbox id"))).files.list(a2 ?? ".");
      if (values.json) return out(items), 0;
      for (const f of items) out(`${f.isDir ? "d" : "-"} ${f.name}${f.isDir ? "/" : ""}`);
      return 0;
    }
    case "url":
      out(await (await router.connect(need(a1, "sandbox id"))).getUrl(Number(need(a2, "port"))));
      return 0;
    case "extend":
      await (await router.connect(need(a1, "sandbox id"))).setTimeout(Number(need(a2, "seconds")));
      return 0;
    case "pause":
      await (await router.connect(need(a1, "sandbox id"))).pause();
      return 0;
    case "resume":
      await (await router.connect(need(a1, "sandbox id"))).resume();
      return 0;
    case "kill":
      await router.kill(need(a1, "sandbox id"));
      return 0;
    case "check": {
      const status = await router.status();
      const named = values.provider ?? [];
      const targets = status.filter((s) =>
        named.length ? named.includes(s.id) : s.configured && s.enabled && (s.free.state === "available" || s.free.state === "unlimited"),
      );
      if (!targets.length) {
        out("no configured provider to check (set its keys; see `sbr providers`)");
        return 1;
      }
      let failures = 0;
      for (const t of targets) {
        const started = Date.now();
        let sbx: Awaited<ReturnType<typeof router.create>> | undefined;
        try {
          // Naming a provider is consent to use it, paid or not, for this one small check.
          if (named.includes(t.id)) router.config.providers[t.id] = { ...router.config.providers[t.id], allowPaid: true };
          sbx = await router.create({ providers: [t.id], timeoutSec: 300 });
          const r = await sbx.commands.run("echo sbr-check && uname -s");
          if (r.exitCode !== 0 || !r.stdout.includes("sbr-check")) throw new Error(`exec gave exit ${r.exitCode}: ${r.stdout}${r.stderr}`);
          const payload = `sbr ${Date.now()}`;
          await sbx.files.write("/tmp/sbr-check/probe.txt", payload);
          const back = await sbx.files.read("/tmp/sbr-check/probe.txt");
          if (back !== payload) throw new Error(`file round trip returned ${JSON.stringify(back)}`);
          const listed = (await sbx.files.list("/tmp/sbr-check")).map((f) => f.name);
          if (!listed.includes("probe.txt")) throw new Error(`list did not show probe.txt: ${listed.join(", ")}`);
          await sbx.kill();
          out(`ok    ${t.id.padEnd(11)} ${((Date.now() - started) / 1000).toFixed(1)}s  create, exec, write, read, list, kill`);
        } catch (raw) {
          failures++;
          const err = raw instanceof NoProviderAvailableError ? raw : classify(raw, t.id);
          out(`FAIL  ${t.id.padEnd(11)} ${err.message.split("\n").slice(0, 3).join(" | ")}`);
          await sbx?.kill().catch(() => undefined);
        }
      }
      return failures ? 1 : 0;
    }
    case "sweep":
      out(await router.sweep({ remote: true }));
      return 0;
    case "reset":
      await router.clearMarks(need(a1, "provider id"));
      return 0;
    case "serve": {
      const { createServer } = await import("./server/http.js");
      const port = Number(values.port ?? process.env["PORT"] ?? 8787);
      const server = createServer(router);
      server.listen(port, "127.0.0.1", () => console.error(`sbr REST API on http://127.0.0.1:${port}/v1`));
      // Reconcile with providers every 5 minutes so crashed clients' sandboxes converge.
      const timer = setInterval(() => router.sweep({ remote: true }).catch(() => undefined), 5 * 60_000);
      timer.unref();
      await new Promise(() => undefined);
      return 0;
    }
    case "mcp": {
      const { serveMcpStdio } = await import("./mcp/server.js");
      await serveMcpStdio(router);
      await new Promise(() => undefined);
      return 0;
    }
    default:
      out(HELP);
      return cmd && cmd !== "help" ? 2 : 0;
  }
}

async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

if (values.help) {
  out(HELP);
} else {
  createRouter()
    .then(main)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((raw) => {
      if (raw instanceof NoProviderAvailableError) console.error(raw.message);
      else {
        const err = classify(raw);
        console.error(`sbr: ${err.kind}: ${err.message}`);
      }
      process.exitCode = 1;
    });
}
