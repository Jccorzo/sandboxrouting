// The seam to AgentRun's computer package, @parcha/agentrun-computer (Apache-2.0, github.com/Parcha-ai/agentrun,
// packages/computer, read at commit 0342949b on 2026-11-21, npm 0.1.0-beta.51). Everything the connector takes from
// AgentRun comes through this file, so moving the connector into AgentRun's repository is moving the files and
// rewriting this one as relative imports (../host.js, ../hosted/provider.js, ../box-image.js, ../drift.js).
//
// Three things here are copies, because the package's exports map doesn't reach them:
// - HostError (src/host.ts). AgentRun reads its own class by instanceof; this copy is read through the host's
//   errorCode hook instead, which the adapter calls for any error that isn't its HostError (src/hosted/process.ts,
//   codeOfError).
// - The label names (src/drift.ts DEADLINE_LABEL, src/hosted/provider.ts NAME_LABEL and MAX_LABEL).
// - boxImageRef (src/box-image.ts): the box image the package's release publishes, by its recipe hash, which this
//   reads from the package's own box/ folder through its package.json, the one file its exports map lets out.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ComputerErrorCode } from "@parcha/agentrun-computer";

export { HostedProvider, defineProvider } from "@parcha/agentrun-computer";
export type {
  ComputerErrorCode,
  ComputerSpec,
  ConformanceModule,
  DialKit,
  HostCall,
  HostedDial,
  HostedOptions,
  HostedTimeouts,
  HostFacts,
  Machine,
  MachineHost,
  MachineRequest,
  Refusal,
  Result,
} from "@parcha/agentrun-computer";
export { ok } from "@parcha/agentrun-computer";

/** A host's failure whose code it knows (a copy of AgentRun's src/host.ts HostError, read through errorCode). */
export class HostError extends Error {
  readonly code: ComputerErrorCode;
  constructor(code: ComputerErrorCode, message: string) {
    super(message);
    this.name = "HostError";
    this.code = code;
  }
}

/** The computer's deadline, an ISO time (src/drift.ts). */
export const DEADLINE_LABEL = "agentrun.computer.deadline";
/** The computer's name, computer-<12 hex> (src/hosted/provider.ts). */
export const NAME_LABEL = "agentrun.computer.name";
/** The most extend may move the deadline to (src/hosted/provider.ts). */
export const MAX_LABEL = "agentrun.computer.max-deadline";
/** The adapter's own namespace: a caller's label may not start with it (src/hosted/provider.ts labelProblem). */
export const COMPUTER_LABEL = "agentrun.computer";

/** Where the release publishes the box image (src/box-image.ts). */
export const BOX_IMAGE_REPOSITORY = "ghcr.io/parcha-ai/agentrun-box";

/** The published box image the installed package's recipe names: ghcr.io/parcha-ai/agentrun-box:<recipe hash>. */
export async function boxImageRef(): Promise<string> {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("@parcha/agentrun-computer/package.json"));
  const recipe = (await import(pathToFileURL(join(root, "box", "recipe.mjs")).href)) as { recipeHash(): string };
  return `${BOX_IMAGE_REPOSITORY}:${recipe.recipeHash()}`;
}
