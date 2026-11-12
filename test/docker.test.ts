// Real sandboxes on local Docker. Skipped when Docker isn't running.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dockerProvider, type ProviderAdapter } from "../src/index.js";
import { router } from "./fake.js";

let dockerUp = false;
try {
  execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
  dockerUp = true;
} catch {
  /* skip */
}

const IMAGE = "alpine:3.20";

describe.skipIf(!dockerUp)("docker provider (real containers)", () => {
  it("create → run → files → kill with native file calls", async () => {
    const { router: r } = router([dockerProvider], { defaults: { timeoutSec: 120 } }, { now: Date.now, advance() {}, set() {} });
    const sbx = await r.create({ image: IMAGE });
    try {
      expect(sbx.provider).toBe("docker");
      const out = await sbx.commands.run("echo hi && echo err >&2 && exit 4");
      expect(out).toEqual({ stdout: "hi\n", stderr: "err\n", exitCode: 4 });
      await sbx.files.write("/work/deep/a.txt", "héllo");
      expect(await sbx.files.read("/work/deep/a.txt")).toBe("héllo");
      expect((await sbx.commands.run("pwd", { cwd: "/work" })).stdout.trim()).toBe("/work");
      expect((await sbx.commands.run("echo $X", { env: { X: "y z" } })).stdout.trim()).toBe("y z");
    } finally {
      await sbx.kill();
    }
    expect((await sbx.info())!.state).toBe("stopped");
    await sbx.kill(); // idempotent
  }, 120_000);

  it("exec fallbacks for files work against a real shell (adapter with only create/exec/kill)", async () => {
    const minimal: ProviderAdapter = {
      info: { ...dockerProvider.info, id: "minimal" },
      isConfigured: () => true,
      create: dockerProvider.create,
      exec: dockerProvider.exec,
      kill: dockerProvider.kill,
    };
    const { router: r } = router([minimal], { defaults: { timeoutSec: 120 } }, { now: Date.now, advance() {}, set() {} });
    const sbx = await r.create({ image: IMAGE });
    try {
      const binary = new Uint8Array(200_000).map((_, i) => (i * 7) % 256); // > one write chunk, non-UTF-8
      await sbx.files.write("/tmp/x/bin.dat", binary);
      expect(Buffer.from(await sbx.files.readBytes("/tmp/x/bin.dat")).equals(Buffer.from(binary))).toBe(true);
      await sbx.files.write("/tmp/x/it's.txt", "quote'd");
      const names = (await sbx.files.list("/tmp/x")).map((f) => f.name).sort();
      expect(names).toEqual(["bin.dat", "it's.txt"]);
      await expect(sbx.files.read("/nope")).rejects.toThrow(/read \/nope/);
    } finally {
      await sbx.kill();
    }
  }, 120_000);

  it("a sandbox killed behind the router's back is recorded as gone by the sweep", async () => {
    const { router: r } = router([dockerProvider], { defaults: { timeoutSec: 120 } }, { now: Date.now, advance() {}, set() {} });
    const sbx = await r.create({ image: IMAGE });
    execFileSync("docker", ["rm", "-f", sbx.providerSandboxId], { stdio: "ignore" });
    expect((await sbx.info())!.state).toBe("running");
    await r.sweep({ remote: true });
    expect((await sbx.info())!.state).toBe("stopped");
  }, 120_000);
});
