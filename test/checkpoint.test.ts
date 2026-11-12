// Workspace checkpoints: the two stores, capture and restore on real shells (local-shell boxes
// are directories on this machine; Docker containers when Docker is up), and moving a live
// sandbox to a new box.

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerProvider, SandboxRouterError, type Sandbox } from "../src/index.js";
import type { CheckpointStore } from "../src/core/jobs/types.js";
import { boxPaths, captureWorkspace, FileCheckpointStore, MemoryCheckpointStore, restoreWorkspace, writeInitialFiles } from "../src/core/jobs/checkpoint.js";
import { moveSandbox } from "../src/core/jobs/move.js";
import { localShellProvider, type LocalShell, type LocalShellOpts } from "./localshell.js";
import { router } from "./fake.js";

// Lets a test make file writes fail halfway through, and records what a crash at that instant
// would leave in the directory (error cleanup never runs after a real crash).
const faults = vi.hoisted(() => ({ failWritesHalfway: false, leftAtFailure: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const { dirname } = await import("node:path");
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      if (faults.failWritesHalfway) {
        const write = fh.writeFile.bind(fh);
        fh.writeFile = (async (data: Uint8Array) => {
          await write(data.subarray(0, data.byteLength >> 1));
          faults.leftAtFailure = await real.readdir(dirname(String(args[0])));
          throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        }) as typeof fh.writeFile;
      }
      return fh;
    },
  };
});

const shells: LocalShell[] = [];
const temps: string[] = [];

function shell(o: LocalShellOpts): LocalShell {
  const s = localShellProvider(o);
  shells.push(s);
  return s;
}

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "sbr-ckpt-test-"));
  temps.push(d);
  return d;
}

afterEach(async () => {
  await Promise.all(shells.splice(0).map((s) => s.cleanup()));
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Every entry under `dir`, by relative path: type, mode, and content hash or link target. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (rel: string): Promise<void> => {
    for (const name of (await readdir(join(dir, rel))).sort()) {
      const p = rel ? `${rel}/${name}` : name;
      const st = await lstat(join(dir, p));
      const mode = (st.mode & 0o777).toString(8);
      if (st.isSymbolicLink()) {
        out[p] = `link -> ${await readlink(join(dir, p))}`;
      } else if (st.isDirectory()) {
        out[p] = `dir ${mode}`;
        await walk(p);
      } else {
        out[p] = `file ${mode} ${createHash("sha256").update(await readFile(join(dir, p))).digest("hex")}`;
      }
    }
  };
  await walk("");
  return out;
}

/** A workspace with the awkward cases: nesting, an empty dir, binary bytes, quotes and spaces, a symlink, an exec bit. */
async function fill(workdir: string): Promise<void> {
  await mkdir(join(workdir, "src/deep/er"), { recursive: true });
  await mkdir(join(workdir, "empty"));
  await writeFile(join(workdir, "src/deep/er/main.py"), "print('hi')\n");
  await writeFile(join(workdir, `it's a "quoted" name.txt`), "spaces and quotes\n");
  await writeFile(join(workdir, "blob.bin"), randomBytes(100_000)); // incompressible: several exec-fallback chunks
  await writeFile(join(workdir, "run.sh"), "#!/bin/sh\necho ok\n", { mode: 0o755 });
  await symlink("src/deep/er/main.py", join(workdir, "link"));
}

async function oneBox(o: Partial<LocalShellOpts> = {}) {
  const ls = shell({ id: "local", ...o });
  const { router: r } = router([ls]);
  const a = await r.create();
  return { ls, r, a, homeA: ls.dirs.get(a.providerSandboxId)! };
}

async function twoBoxes(o: Partial<LocalShellOpts> = {}) {
  const { ls, r, a, homeA } = await oneBox(o);
  const b = await r.create();
  return { ls, r, a, b, homeA, homeB: ls.dirs.get(b.providerSandboxId)! };
}

// ------------------------------------------------------------------ stores

const CLOCK = () => Date.UTC(2026, 10, 11, 12, 0, 0);

describe.each<[string, () => Promise<CheckpointStore>]>([
  ["FileCheckpointStore", async () => new FileCheckpointStore(join(await tempDir(), "checkpoints"), CLOCK)],
  ["MemoryCheckpointStore", async () => new MemoryCheckpointStore(CLOCK)],
])("%s", (_name, make) => {
  it("round-trips the bytes, describes them in the ref, and shares no buffers", async () => {
    const store = await make();
    const data = randomBytes(5000);
    const original = Buffer.from(data);
    const sha = createHash("sha256").update(data).digest("hex");

    const ref = await store.put("job_a1", 3, data);
    expect(ref).toEqual({ key: `3-${sha.slice(0, 16)}`, sha256: sha, bytes: 5000, step: 3, at: "2026-11-11T12:00:00.000Z" });
    const back = await store.get("job_a1", ref);
    expect(Buffer.from(back).equals(original)).toBe(true);

    data.fill(0);
    back.fill(0);
    expect(Buffer.from(await store.get("job_a1", ref)).equals(original)).toBe(true);
  });

  it("refuses bytes whose sha256 differs from the ref", async () => {
    const store = await make();
    const ref = await store.put("job_a1", 0, randomBytes(100));
    await expect(store.get("job_a1", { ...ref, sha256: "0".repeat(64) })).rejects.toMatchObject({ kind: "invalid", message: expect.stringMatching(/corrupt/) });
  });

  it("a missing archive is not_found", async () => {
    const store = await make();
    const ref = await store.put("job_a1", 0, randomBytes(100));
    await expect(store.get("job_other", ref)).rejects.toMatchObject({ kind: "not_found" });
    await store.prune("job_a1");
    await expect(store.get("job_a1", ref)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("prune keeps only the given archive, or none", async () => {
    const store = await make();
    const r0 = await store.put("job_a1", 0, randomBytes(100));
    const r1 = await store.put("job_a1", 1, randomBytes(100));
    const r2 = await store.put("job_a1", 2, randomBytes(100));
    const other = await store.put("job_b2", 0, randomBytes(100));

    await store.prune("job_a1", r1);
    await expect(store.get("job_a1", r0)).rejects.toMatchObject({ kind: "not_found" });
    await expect(store.get("job_a1", r2)).rejects.toMatchObject({ kind: "not_found" });
    expect((await store.get("job_a1", r1)).byteLength).toBe(100);

    await store.prune("job_a1");
    await expect(store.get("job_a1", r1)).rejects.toMatchObject({ kind: "not_found" });
    await store.prune("job_a1"); // nothing left
    await store.prune("job_never_seen");
    expect((await store.get("job_b2", other)).byteLength).toBe(100); // other jobs untouched
  });

  it("rejects job ids, keys and steps that could leave the store's directory", async () => {
    const store = await make();
    const ref = await store.put("job_a1", 0, randomBytes(10));
    for (const bad of ["../escape", "a/b", "..", ".", "", "job 1", "job\\1"]) {
      await expect(store.put(bad, 0, randomBytes(10)), bad).rejects.toMatchObject({ kind: "invalid" });
      await expect(store.get(bad, ref), bad).rejects.toMatchObject({ kind: "invalid" });
      await expect(store.prune(bad), bad).rejects.toMatchObject({ kind: "invalid" });
    }
    await expect(store.get("job_a1", { ...ref, key: "../../../etc/passwd" })).rejects.toMatchObject({ kind: "invalid" });
    await expect(store.prune("job_a1", { ...ref, key: "../job_a1/x" })).rejects.toMatchObject({ kind: "invalid" });
    for (const step of [-1, 1.5, Number.NaN]) {
      await expect(store.put("job_a1", step, randomBytes(10)), String(step)).rejects.toMatchObject({ kind: "invalid" });
    }
    // The refused prune deleted nothing.
    expect((await store.get("job_a1", ref)).byteLength).toBe(10);
  });
});

describe("FileCheckpointStore on disk", () => {
  it("writes whole: a write that dies halfway leaves nothing under the final name, and no temp file", async () => {
    const dir = await tempDir();
    const store = new FileCheckpointStore(dir);
    const data = randomBytes(1 << 20);
    const name = `0-${createHash("sha256").update(data).digest("hex").slice(0, 16)}.tgz`;

    faults.failWritesHalfway = true;
    try {
      await expect(store.put("job_a1", 0, data)).rejects.toThrow(/ENOSPC/);
    } finally {
      faults.failWritesHalfway = false;
    }
    // Mid-write, the half-written bytes sat in a temp file, never under the archive's name.
    expect(faults.leftAtFailure).toHaveLength(1);
    expect(faults.leftAtFailure[0]).toMatch(new RegExp(`^${name.replace(/\./g, "\\.")}\\..+\\.tmp$`));
    // And the failed put removed it.
    expect(await readdir(join(dir, "job_a1"))).toEqual([]);

    const ref = await store.put("job_a1", 0, data);
    expect(`${ref.key}.tgz`).toBe(name);
    expect(await readdir(join(dir, "job_a1"))).toEqual([name]);
    expect(Buffer.from(await store.get("job_a1", ref)).equals(data)).toBe(true);
  });

  it("detects an archive changed on disk", async () => {
    const dir = await tempDir();
    const store = new FileCheckpointStore(dir);
    const ref = await store.put("job_a1", 4, randomBytes(1000));
    const path = join(dir, "job_a1", `${ref.key}.tgz`);
    const bytes = await readFile(path);
    bytes[500] = bytes[500]! ^ 0xff;
    await writeFile(path, bytes);
    await expect(store.get("job_a1", ref)).rejects.toMatchObject({ kind: "invalid", message: expect.stringMatching(/corrupt/) });
  });

  it("prune clears temp files a crashed write left behind, and leaves files it didn't make", async () => {
    const dir = await tempDir();
    const store = new FileCheckpointStore(dir);
    const ref = await store.put("job_a1", 1, randomBytes(100));
    await writeFile(join(dir, "job_a1", `${ref.key}.tgz.4242.deadbeef.tmp`), "half an archive");
    await writeFile(join(dir, "job_a1", "notes.txt"), "not ours");

    await store.prune("job_a1", ref);
    expect((await readdir(join(dir, "job_a1"))).sort()).toEqual([`${ref.key}.tgz`, "notes.txt"]);

    await store.prune("job_a1");
    expect(await readdir(join(dir, "job_a1"))).toEqual(["notes.txt"]);
    await rm(join(dir, "job_a1", "notes.txt"));
    await store.prune("job_a1");
    expect(await readdir(dir)).toEqual([]);
  });

  it("writes nothing outside its directory for a hostile job id", async () => {
    const root = await tempDir();
    const store = new FileCheckpointStore(join(root, "checkpoints"));
    await expect(store.put("../escape", 0, randomBytes(10))).rejects.toMatchObject({ kind: "invalid" });
    expect(await readdir(root)).toEqual([]);
  });
});

// ------------------------------------------------------------------ on the box

describe("boxPaths", () => {
  it("puts a relative workdir under $HOME and refuses any that restore would wipe along with $HOME", async () => {
    const { a, homeA } = await oneBox();
    expect(await boxPaths(a, "work")).toEqual({ home: homeA, workdir: join(homeA, "work"), tmp: join(homeA, ".sbr-tmp") });
    expect((await boxPaths(a, "a/b/../c/")).workdir).toBe(join(homeA, "a/c"));
    expect((await boxPaths(a, "/srv/work")).workdir).toBe("/srv/work");
    for (const bad of ["/", "", ".", "..", "../..", "work/../..", homeA, `${homeA}/`, ".sbr-tmp", ".sbr-tmp/x"]) {
      await expect(boxPaths(a, bad), bad).rejects.toMatchObject({ kind: "invalid" });
    }
  });

  it("falls back to pwd when $HOME is empty", async () => {
    const { a, homeA } = await oneBox({
      execHook: (_id, command) => (command === `printf '%s' "$HOME"` ? { stdout: "", stderr: "", exitCode: 0 } : undefined),
    });
    const home = await realpath(homeA);
    expect(await boxPaths(a, "work")).toEqual({ home, workdir: join(home, "work"), tmp: join(home, ".sbr-tmp") });
  });
});

describe("capture and restore (local-shell boxes)", () => {
  it("capture on one box and restore on another gives identical files", async () => {
    const { a, b } = await twoBoxes();
    const pa = await boxPaths(a, "work");
    await fill(pa.workdir);
    const archive = await captureWorkspace(a, pa);

    const pb = await boxPaths(b, "work");
    await restoreWorkspace(b, pb, archive);

    const want = await tree(pa.workdir);
    expect(Object.keys(want)).toEqual(expect.arrayContaining(["empty", "src/deep/er/main.py", `it's a "quoted" name.txt`, "blob.bin", "link", "run.sh"]));
    expect(want["run.sh"]).toMatch(/^file 755 /);
    expect(await tree(pb.workdir)).toEqual(want);
    // No scratch archive left on either box.
    expect(await readdir(pa.tmp)).toEqual([]);
    expect(await readdir(pb.tmp)).toEqual([]);
  });

  it("restore removes files that aren't in the archive", async () => {
    const { a, b } = await twoBoxes();
    const pa = await boxPaths(a, "work");
    await fill(pa.workdir);
    const archive = await captureWorkspace(a, pa);

    const pb = await boxPaths(b, "work");
    await mkdir(join(pb.workdir, "src/deep/er"), { recursive: true });
    await writeFile(join(pb.workdir, "src/deep/er/leftover.py"), "old");
    await writeFile(join(pb.workdir, "extra.txt"), "old");
    await restoreWorkspace(b, pb, archive);
    expect(await tree(pb.workdir)).toEqual(await tree(pa.workdir));
  });

  it("restore is idempotent and leaves no scratch files", async () => {
    const { a, b } = await twoBoxes();
    const pa = await boxPaths(a, "work");
    await fill(pa.workdir);
    const archive = await captureWorkspace(a, pa);

    const pb = await boxPaths(b, "work");
    await restoreWorkspace(b, pb, archive);
    const first = await tree(pb.workdir);
    await restoreWorkspace(b, pb, archive);
    expect(await tree(pb.workdir)).toEqual(first);
    expect(first).toEqual(await tree(pa.workdir));
    expect(await readdir(pb.tmp)).toEqual([]);
  });

  it("refuses a workspace over maxBytes, naming maxCheckpointBytes, and removes the archive it made", async () => {
    const { a } = await oneBox();
    const p = await boxPaths(a, "work");
    await fill(p.workdir);
    await expect(captureWorkspace(a, p, { maxBytes: 1000 })).rejects.toMatchObject({ kind: "invalid", message: expect.stringMatching(/maxCheckpointBytes/) });
    expect(await readdir(p.tmp)).toEqual([]);
    expect((await captureWorkspace(a, p, { maxBytes: 10_000_000 })).byteLength).toBeGreaterThan(100_000);
  });

  it("a box without tar is unsupported; a corrupt archive is transient with tar's stderr, and a retry converges", async () => {
    const { a: noTar } = await oneBox({
      id: "notar",
      execHook: (_id, command) => (command.includes("tar -") ? { stdout: "", stderr: "sh: tar: not found\n", exitCode: 127 } : undefined),
    });
    const px = await boxPaths(noTar, "work");
    await expect(captureWorkspace(noTar, px)).rejects.toMatchObject({ kind: "unsupported", message: expect.stringContaining("needs tar and gzip on the box") });
    await expect(restoreWorkspace(noTar, px, new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ kind: "unsupported" });

    const { a, b } = await twoBoxes();
    const pa = await boxPaths(a, "work");
    await fill(pa.workdir);
    const archive = await captureWorkspace(a, pa);
    const pb = await boxPaths(b, "work");

    const err = await restoreWorkspace(b, pb, new TextEncoder().encode("not a tarball")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxRouterError);
    expect(err).toMatchObject({ kind: "transient", message: expect.stringMatching(/^restoring .* failed \(exit [1-9]\d*\): \S/) });
    expect(await readdir(pb.tmp)).toEqual([]);

    await restoreWorkspace(b, pb, archive);
    expect(await tree(pb.workdir)).toEqual(await tree(pa.workdir));
  });

  it("writeInitialFiles makes the workdir exactly those files and refuses paths outside it", async () => {
    const { a, homeA } = await oneBox();
    const p = await boxPaths(a, "work");
    await mkdir(join(p.workdir, "old"), { recursive: true });
    await writeFile(join(p.workdir, "old/stale.txt"), "stale");

    const files = { "main.py": "print(1)\n", "pkg/mod/util.py": "x = 1\n", [`it's a "q".txt`]: "q" };
    await writeInitialFiles(a, p, files);
    const first = await tree(p.workdir);
    expect(Object.keys(first).sort()).toEqual([`it's a "q".txt`, "main.py", "pkg", "pkg/mod", "pkg/mod/util.py"]);
    expect(await readFile(join(p.workdir, "pkg/mod/util.py"), "utf8")).toBe("x = 1\n");
    await writeInitialFiles(a, p, files);
    expect(await tree(p.workdir)).toEqual(first);

    for (const bad of ["../x", "/etc/x", "a/../../x", "", ".", "dir/"]) {
      await expect(writeInitialFiles(a, p, { "ok.txt": "fine", [bad]: "no" }), bad).rejects.toMatchObject({ kind: "invalid" });
    }
    // Refused before anything ran: the workdir is unchanged and nothing landed beside it.
    expect(await tree(p.workdir)).toEqual(first);
    await expect(stat(join(homeA, "x"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips through the exec fallbacks when the adapter has no file calls", async () => {
    const { a, b } = await twoBoxes({ id: "nofiles", nativeFiles: false });
    const pa = await boxPaths(a, "work");
    await fill(pa.workdir);
    const archive = await captureWorkspace(a, pa);
    expect(archive.byteLength).toBeGreaterThan(64 * 1024); // more than one upload chunk

    const pb = await boxPaths(b, "work");
    await restoreWorkspace(b, pb, archive);
    expect(await tree(pb.workdir)).toEqual(await tree(pa.workdir));
    expect(await readdir(pa.tmp)).toEqual([]);
    expect(await readdir(pb.tmp)).toEqual([]); // no .sbr-upload part file either

    await writeInitialFiles(b, pb, { "nested/dir/f.txt": "via exec" });
    expect(await readFile(join(pb.workdir, "nested/dir/f.txt"), "utf8")).toBe("via exec");
  });

  it("an upload that fails leaves no part file in the scratch dir", async () => {
    const { a, b } = await twoBoxes({
      id: "badupload",
      nativeFiles: false,
      execHook: (_id, command) => (command.includes("base64 -d") ? { stdout: "", stderr: "base64: invalid input\n", exitCode: 1 } : undefined),
    });
    const pa = await boxPaths(a, "work");
    await fill(pa.workdir);
    const archive = await captureWorkspace(a, pa);
    const pb = await boxPaths(b, "work");
    await expect(restoreWorkspace(b, pb, archive)).rejects.toMatchObject({ kind: "transient", message: expect.stringContaining("invalid input") });
    expect(await readdir(pb.tmp)).toEqual([]);
  });
});

// ------------------------------------------------------------------ moving a sandbox

describe("moveSandbox", () => {
  async function setup(bOpts: Partial<LocalShellOpts> = {}) {
    const a = shell({ id: "a" });
    const b = shell({ id: "b", ...bOpts });
    const { router: r, clock } = router([a, b]);
    const old = await r.create({ providers: ["a"] });
    const oldWork = join(a.dirs.get(old.providerSandboxId)!, "work");
    await fill(oldWork);
    return { a, b, r, clock, old, oldWork, expected: await tree(oldWork) };
  }

  it("copies the workdir to a box on another provider, then kills the old box", async () => {
    const { a, b, r, old, expected } = await setup();
    const moved = await moveSandbox(r, old.id, { spec: { providers: ["b"] } });

    expect(moved.provider).toBe("b");
    expect(await tree(join(b.dirs.get(moved.providerSandboxId)!, "work"))).toEqual(expected);
    expect(a.killed).toEqual([old.providerSandboxId]);
    expect((await r.get(old.id))!.state).toBe("stopped");
    expect((await moved.info())!.metadata["sandboxrouting.movedFrom"]).toBe(old.id);
  });

  it("a failed restore kills the new box and leaves the old one running with its files", async () => {
    const { a, b, r, old, oldWork, expected } = await setup({
      execHook: (_id, command) => (command.includes("tar -xzf") ? { stdout: "", stderr: "tar: write error: disk full\n", exitCode: 2 } : undefined),
    });
    await expect(moveSandbox(r, old.id, { spec: { providers: ["b"] } })).rejects.toMatchObject({ kind: "transient", message: expect.stringContaining("disk full") });

    expect(b.created).toHaveLength(1);
    expect(b.killed).toEqual(b.created);
    expect(a.killed).toEqual([]);
    expect((await r.get(old.id))!.state).toBe("running");
    expect(await tree(oldWork)).toEqual(expected);
  });

  it("leaves the old box alone when no new box can be had", async () => {
    const { a, r, old, oldWork, expected } = await setup();
    await expect(moveSandbox(r, old.id, { spec: { exclude: ["a", "b"] } })).rejects.toThrow(/No sandbox provider could take this request/);
    expect(a.killed).toEqual([]);
    expect((await r.get(old.id))!.state).toBe("running");
    expect(await tree(oldWork)).toEqual(expected);
  });

  it("returns the new box even when killing the old one fails", async () => {
    const { a, b, r, old, expected } = await setup();
    a.kill = async () => {
      throw Object.assign(new Error("upstream exploded"), { status: 500 });
    };
    const moved = await moveSandbox(r, old.id, { spec: { providers: ["b"] } });
    expect(await tree(join(b.dirs.get(moved.providerSandboxId)!, "work"))).toEqual(expected);
    // The kill is recorded before the provider is asked, so the ledger says stopped; the
    // remote sweep deletes the box if the provider still has it alive.
    expect((await r.get(old.id))!.state).toBe("stopped");
  });

  it("refuses a sandbox that is over by the ledger (past its deadline, or killed), before creating anything", async () => {
    const { b, r, clock, old } = await setup();
    clock.advance(301_000); // past the default 300 s timeout; the local box itself still answers
    await expect(moveSandbox(r, old.id)).rejects.toMatchObject({ kind: "not_found", message: expect.stringContaining("is expired") });
    expect(b.created).toEqual([]);

    await old.kill();
    await expect(moveSandbox(r, old.id)).rejects.toMatchObject({ kind: "not_found", message: expect.stringContaining("is stopped") });
    expect(b.created).toEqual([]);
  });
});

// ------------------------------------------------------------------ real containers

let dockerUp = false;
try {
  execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
  dockerUp = true;
} catch {
  /* skip */
}

describe.skipIf(!dockerUp)("checkpoints between real Docker containers", () => {
  it("captures in one container and restores in another", async () => {
    const { router: r } = router([dockerProvider], { defaults: { timeoutSec: 120 } }, { now: Date.now, advance() {}, set() {} });
    const boxes: Sandbox[] = [];
    try {
      const a = await r.create({ image: "alpine:3.20" });
      boxes.push(a);
      const pa = await boxPaths(a, "work");
      expect(pa).toEqual({ home: "/root", workdir: "/root/work", tmp: "/root/.sbr-tmp" });
      await a.files.write("/root/work/src/deep/main.py", "print('hi')\n");
      await a.files.write(`/root/work/it's a "quoted" name.txt`, "spaces and quotes\n");
      await a.files.write("/root/work/blob.bin", randomBytes(100_000));
      const made = await a.commands.run(
        "cd /root/work && mkdir empty && ln -s src/deep/main.py link && printf '#!/bin/sh\\n' > run.sh && chmod 755 run.sh && chown -R 1234:1234 .",
      );
      expect(made).toMatchObject({ exitCode: 0 });
      const archive = await captureWorkspace(a, pa);

      const b = await r.create({ image: "alpine:3.20" });
      boxes.push(b);
      const pb = await boxPaths(b, "work");
      await restoreWorkspace(b, pb, archive);

      const manifest = "cd /root/work && find . -exec stat -c '%n|%F|%a' {} + | sort && find . -type f -exec sha256sum {} + | sort";
      const want = await a.commands.run(manifest);
      const got = await b.commands.run(manifest);
      expect(got.exitCode).toBe(0);
      expect(got.stdout).toBe(want.stdout);
      expect(got.stdout).toContain("./empty|directory|755");
      expect(got.stdout).toContain("./link|symbolic link|");
      // Owned by the user who restored, not uid 1234 from the other box.
      expect((await b.commands.run("find /root/work ! -user root")).stdout).toBe("");
      expect((await a.commands.run("ls -A /root/.sbr-tmp")).stdout).toBe("");
      expect((await b.commands.run("ls -A /root/.sbr-tmp")).stdout).toBe("");
    } finally {
      for (const s of boxes) await s.kill().catch(() => undefined);
    }
  }, 120_000);
});
