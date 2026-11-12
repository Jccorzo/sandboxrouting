// `router.move(id)`: carry an interactive sandbox's workdir to a new box, then retire the old
// one. The old box stays alive until the new one holds the workspace, so whatever fails, the
// caller still has a sandbox with their files.

import { SandboxRouterError } from "../errors.js";
import type { SandboxRouter } from "../router.js";
import type { Sandbox } from "../sandbox.js";
import type { SandboxSpec } from "../types.js";
import { boxPaths, captureWorkspace, restoreWorkspace } from "./checkpoint.js";

/** Copies a live sandbox's workdir to a new box and kills the old one. Returns the new sandbox. */
export async function moveSandbox(router: SandboxRouter, id: string, opts: { workdir?: string; spec?: SandboxSpec } = {}): Promise<Sandbox> {
  const workdir = opts.workdir ?? "work";
  const old = await router.connect(id);
  const view = await old.info();
  if (view && view.state !== "running") {
    throw new SandboxRouterError(view.state === "paused" ? "invalid" : "not_found", `${old.id} is ${view.state}; only a running sandbox can be moved`, old.provider);
  }
  const archive = await captureWorkspace(old, await boxPaths(old, workdir), { maxBytes: router.config.jobs.maxCheckpointBytes });

  // The router id, not `id`: they differ when `id` adopted a sandbox as provider:providerSandboxId.
  const next = await router.create({ ...opts.spec, metadata: { ...opts.spec?.metadata, "sandboxrouting.movedFrom": old.id } });
  try {
    await restoreWorkspace(next, await boxPaths(next, workdir), archive);
  } catch (err) {
    // The old box still has everything; don't leave a half-restored copy running beside it.
    await next.kill().catch(() => undefined);
    throw err;
  }

  // The new box has the workspace. A failed kill only delays the old box's end: its deadline
  // or the sweep stops it, and the caller already holds the sandbox they asked for.
  await old.kill().catch(() => undefined);
  return next;
}
