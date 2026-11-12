// Workspace checkpoints: a job's workdir as a tar.gz, made on one box, kept here, unpacked on
// the next. The archive is the job's durable state (docs/routing.md §3), so the stores write it
// whole and check its SHA-256 on every read, and the box helpers trust only exit codes.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { SandboxRouterError } from "../errors.js";
import { shellQuote, type Sandbox } from "../sandbox.js";
import type { ExecResult } from "../types.js";
import type { CheckpointRef, CheckpointStore } from "./types.js";

// ------------------------------------------------------------------ stores

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/** Job ids and keys become path segments, so nothing that could climb out of the directory. */
function safe(what: string, name: string): string {
  if (!SAFE_NAME.test(name)) throw new SandboxRouterError("invalid", `${what} ${JSON.stringify(name)} may only contain letters, digits, "_" and "-"`);
  return name;
}

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function refFor(step: number, data: Uint8Array, now: number): CheckpointRef {
  // A checkpoint holds the effects of a step that ran; job validation rejects negative ones.
  if (!Number.isSafeInteger(step) || step < 0) throw new SandboxRouterError("invalid", `checkpoint step must be a non-negative integer, not ${step}`);
  const hash = sha256(data);
  return { key: `${step}-${hash.slice(0, 16)}`, sha256: hash, bytes: data.byteLength, step, at: new Date(now).toISOString() };
}

function verified(jobId: string, ref: CheckpointRef, data: Uint8Array): Uint8Array {
  const hash = sha256(data);
  if (hash !== ref.sha256) {
    throw new SandboxRouterError(
      "invalid",
      `checkpoint ${ref.key} of job ${jobId} is corrupt: sha256 ${hash} (${data.byteLength} bytes), expected ${ref.sha256} (${ref.bytes} bytes)`,
    );
  }
  return data;
}

const missing = (jobId: string, ref: CheckpointRef) => new SandboxRouterError("not_found", `checkpoint ${ref.key} of job ${jobId} is missing`);

/** Archives at `<dir>/<jobId>/<key>.tgz`, e.g. under ~/.sandboxrouting/checkpoints. */
export class FileCheckpointStore implements CheckpointStore {
  constructor(
    readonly dir: string,
    /** Clock for `CheckpointRef.at`; pass the router's so job records use one clock. */
    private readonly now: () => number = Date.now,
  ) {}

  private jobDir(jobId: string): string {
    return join(this.dir, safe("job id", jobId));
  }

  async put(jobId: string, step: number, data: Uint8Array): Promise<CheckpointRef> {
    const dir = this.jobDir(jobId);
    const ref = refFor(step, data, this.now());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeWhole(join(dir, `${ref.key}.tgz`), data);
    return ref;
  }

  async get(jobId: string, ref: CheckpointRef): Promise<Uint8Array> {
    const path = join(this.jobDir(jobId), `${safe("checkpoint key", ref.key)}.tgz`);
    let data: Uint8Array;
    try {
      data = new Uint8Array(await readFile(path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw missing(jobId, ref);
      throw err;
    }
    return verified(jobId, ref, data);
  }

  async prune(jobId: string, keep?: CheckpointRef): Promise<void> {
    const dir = this.jobDir(jobId);
    const kept = keep && `${safe("checkpoint key", keep.key)}.tgz`;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    // Archives, and temp files a crashed put left behind. Nothing else in there is ours.
    const doomed = names.filter((n) => n !== kept && (n.endsWith(".tgz") || n.endsWith(".tmp")));
    await Promise.all(doomed.map((n) => rm(join(dir, n), { force: true })));
    if (!keep) await rmdir(dir).catch(() => undefined); // stays if something else is inside
  }
}

/** Temp file in the same directory, fsync, rename: readers see the whole archive or none. */
async function writeWhole(path: string, data: Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx", 0o600);
  try {
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  // The job record will point at this file, so make the rename itself durable too.
  try {
    const dh = await open(dirname(path), "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // Some platforms can't fsync a directory; the file's own contents are already synced.
  }
}

/** Archives in memory, for tests and embedding. Copies bytes in and out, as a disk would. */
export class MemoryCheckpointStore implements CheckpointStore {
  private readonly jobs = new Map<string, Map<string, Uint8Array>>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(jobId: string, step: number, data: Uint8Array): Promise<CheckpointRef> {
    safe("job id", jobId);
    const ref = refFor(step, data, this.now());
    let archives = this.jobs.get(jobId);
    if (!archives) this.jobs.set(jobId, (archives = new Map()));
    archives.set(ref.key, new Uint8Array(data));
    return ref;
  }

  async get(jobId: string, ref: CheckpointRef): Promise<Uint8Array> {
    const data = this.jobs.get(safe("job id", jobId))?.get(safe("checkpoint key", ref.key));
    if (!data) throw missing(jobId, ref);
    return verified(jobId, ref, new Uint8Array(data));
  }

  async prune(jobId: string, keep?: CheckpointRef): Promise<void> {
    const kept = keep && safe("checkpoint key", keep.key);
    const archives = this.jobs.get(safe("job id", jobId));
    if (!archives) return;
    for (const key of [...archives.keys()]) if (key !== kept) archives.delete(key);
    if (!archives.size) this.jobs.delete(jobId);
  }
}

// ------------------------------------------------------------------ on the box

export interface BoxPaths {
  home: string;
  workdir: string;
  tmp: string;
}

/** Whether `path` is `dir` or inside it. */
const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/** Runs a command that must exit 0 and returns its stdout without the trailing newline. */
async function output(sbx: Sandbox, command: string, what: string): Promise<string> {
  const r = await sbx.commands.run(command);
  if (r.exitCode !== 0) throw new SandboxRouterError("transient", `${what} failed (exit ${r.exitCode}): ${r.stderr.trim()}`, sbx.provider);
  return r.stdout.replace(/[\r\n]+$/, "");
}

/** The error for a failed tar command: a missing tar or gzip can't be retried away. */
function tarFailure(sbx: Sandbox, r: ExecResult, what: string): SandboxRouterError {
  const stderr = r.stderr.trim();
  // "sh: tar: not found" (exit 127), or GNU tar unable to start gzip.
  if (r.exitCode === 127 || /not found|cannot exec/i.test(stderr)) {
    return new SandboxRouterError("unsupported", `${what} needs tar and gzip on the box: ${stderr || `exit ${r.exitCode}`}`, sbx.provider);
  }
  return new SandboxRouterError("transient", `${what} failed (exit ${r.exitCode}): ${stderr}`, sbx.provider);
}

/** Restore and initial files `rm -rf` the workdir, so take only absolute paths below "/". */
function checkPaths(paths: { workdir: string; tmp?: string }): void {
  const { workdir, tmp } = paths;
  if (!workdir.startsWith("/") || posix.resolve(workdir) === "/" || (tmp !== undefined && !tmp.startsWith("/"))) {
    const got = `workdir ${JSON.stringify(workdir)}${tmp === undefined ? "" : `, tmp ${JSON.stringify(tmp)}`}`;
    throw new SandboxRouterError("invalid", `pass the absolute paths boxPaths returns (got ${got})`);
  }
}

const scratchFile = (tmp: string, kind: string) => posix.join(tmp, `${kind}-${randomBytes(6).toString("hex")}.tgz`);

/** Absolute paths on this box: $HOME, the workdir (relative → under $HOME), and a scratch dir. */
export async function boxPaths(sbx: Sandbox, workdir: string): Promise<{ home: string; workdir: string; tmp: string }> {
  let home = await output(sbx, `printf '%s' "$HOME"`, "reading $HOME");
  if (!home) home = await output(sbx, "pwd", "reading the working directory");
  if (!home.startsWith("/")) throw new SandboxRouterError("unsupported", `cannot tell the box's home directory (got ${JSON.stringify(home)})`, sbx.provider);
  home = posix.resolve(home);
  const dir = posix.resolve(home, workdir);
  // Scratch files stay on the box under $HOME: /tmp may be shared or small.
  const tmp = posix.join(home, ".sbr-tmp");
  // Restore runs `rm -rf` on the workdir; that must never take $HOME or the scratch dir with it.
  if (within(home, dir) || within(dir, tmp)) {
    throw new SandboxRouterError(
      "invalid",
      `workdir ${JSON.stringify(workdir)} resolves to ${dir}, which restore would wipe: it can't be "/", $HOME (${home}) or above it, or under ${tmp}`,
      sbx.provider,
    );
  }
  return { home, workdir: dir, tmp };
}

/** tar+gzip the workdir on the box and download it. */
export async function captureWorkspace(sbx: Sandbox, paths: { workdir: string; tmp: string }, opts: { maxBytes?: number } = {}): Promise<Uint8Array> {
  checkPaths(paths);
  const file = scratchFile(paths.tmp, "ckpt");
  const [w, t, f] = [paths.workdir, paths.tmp, file].map(shellQuote);
  try {
    const r = await sbx.commands.run(`mkdir -p ${w} ${t} && tar -czf ${f} -C ${w} . && wc -c < ${f}`);
    if (r.exitCode !== 0) throw tarFailure(sbx, r, `checkpointing ${paths.workdir}`);
    const printed = r.stdout.trim();
    if (!/^\d+$/.test(printed)) throw new SandboxRouterError("transient", `checkpointing ${paths.workdir}: unexpected archive size ${JSON.stringify(printed)}`, sbx.provider);
    const size = Number(printed);
    if (opts.maxBytes !== undefined && size > opts.maxBytes) {
      throw new SandboxRouterError(
        "invalid",
        `workspace ${paths.workdir} is ${size} bytes as tar.gz, over maxCheckpointBytes (${opts.maxBytes}): keep large files out of the workdir or raise jobs.maxCheckpointBytes`,
        sbx.provider,
      );
    }
    const data = await sbx.files.readBytes(file);
    if (data.byteLength !== size) throw new SandboxRouterError("transient", `checkpointing ${paths.workdir}: downloaded ${data.byteLength} of ${size} bytes`, sbx.provider);
    return data;
  } finally {
    await sbx.commands.run(`rm -f ${f}`).catch(() => undefined);
  }
}

/** Replace the workdir with the archive's contents (rm -rf, mkdir -p, extract). Idempotent. */
export async function restoreWorkspace(sbx: Sandbox, paths: { workdir: string; tmp: string }, archive: Uint8Array): Promise<void> {
  checkPaths(paths);
  const file = scratchFile(paths.tmp, "restore");
  const [w, t, f] = [paths.workdir, paths.tmp, file].map(shellQuote);
  // Not every adapter's native write creates missing parent directories.
  await output(sbx, `mkdir -p ${t}`, `creating ${paths.tmp}`);
  let removed = false;
  try {
    await sbx.files.write(file, archive);
    // Remove the upload whatever happens, but exit with tar's status. The `*` also takes the
    // part file the exec-fallback upload writes beside it. Files keep the restoring user as
    // owner: uids differ between boxes, and git refuses repositories owned by someone else.
    const r = await sbx.commands.run(`rm -rf ${w} && mkdir -p ${w} && tar -xzf ${f} --no-same-owner -C ${w}; s=$?; rm -f ${f}*; exit $s`);
    removed = true;
    if (r.exitCode !== 0) throw tarFailure(sbx, r, `restoring ${paths.workdir}`);
  } finally {
    if (!removed) await sbx.commands.run(`rm -f ${f}*`).catch(() => undefined);
  }
}

/** Make the workdir exactly these files (rm -rf, mkdir -p, write each). Idempotent. */
export async function writeInitialFiles(sbx: Sandbox, paths: { workdir: string }, files: Record<string, string>): Promise<void> {
  checkPaths(paths);
  const targets = Object.entries(files).map(([rel, content]) => {
    const parts = rel.split("/");
    const last = parts[parts.length - 1];
    if (rel.startsWith("/") || parts.includes("..") || !last || last === ".") {
      throw new SandboxRouterError("invalid", `initial file ${JSON.stringify(rel)} must be a file path relative to the workdir, without ".."`);
    }
    return { path: posix.join(paths.workdir, rel), content };
  });
  // Parents are made here as well, in the same exec: native writes don't always create them.
  const dirs = new Set([paths.workdir, ...targets.map((t) => posix.dirname(t.path))]);
  await output(sbx, `rm -rf ${shellQuote(paths.workdir)} && mkdir -p ${[...dirs].map(shellQuote).join(" ")}`, `resetting ${paths.workdir}`);
  for (const { path, content } of targets) await sbx.files.write(path, content);
}
