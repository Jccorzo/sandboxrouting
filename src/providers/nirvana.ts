// Nirvana Labs Agent Sandboxes: containers on a sandbox cluster, a managed Kubernetes cluster
// of AMD EPYC nodes you create in a Nirvana project ("container walls around each sandbox, VM
// walls around each node, and a dedicated NKS cluster per customer"). Early release.
// The Nirvana API serves OpenSandbox's Sandbox Lifecycle API (server v0.2.0) at
// https://api.nirvanalabs.io/v1/sandboxes, so this is the `opensandbox` adapter's code with
// Nirvana's key, `extensions["nirvana.sandbox_cluster_id"]` on create, and no pause (409
// SANDBOX_PAUSE_NOT_SUPPORTED) or snapshots. Ports and execd are reached through signed
// endpoints on the cluster's gateway (gateway hostname plus an OpenSandbox-Ingress-To header).
// Docs (checked 2026-11-21):
//   https://docs.nirvanalabs.io/cloud/compute/agent-sandboxes/index.md
//   https://docs.nirvanalabs.io/cloud/compute/agent-sandboxes/api-reference/index.md
//   https://docs.nirvanalabs.io/cloud/compute/agent-sandboxes/how-to/connect-to-sandbox-cluster/index.md
//   https://docs.nirvanalabs.io/cloud/compute/agent-sandboxes/how-to/access-endpoint/index.md
//   https://docs.nirvanalabs.io/api/openapi.json (sandbox clusters)
// Billing is for the cluster's nodes, by the hour, whether or not sandboxes run on them:
// $0.016 per vCPU-hour and $0.004 per GB-hour (nirvanalabs.io/md, "How is Nirvana Labs
// priced?"). The adapter prices a sandbox at that rate for its size, its share of the nodes.

import { defineProvider } from "./util.js";
import { opensandboxBase, opensandboxCompatible } from "./opensandbox.js";

export const nirvanaProvider = defineProvider(
  opensandboxCompatible({
    info: {
      id: "nirvana",
      name: "Nirvana Labs Agent Sandboxes",
      homepage: "https://nirvanalabs.io/product/compute/agent-sandboxes",
      env: ["NIRVANA_API_KEY", "NIRVANA_SANDBOX_CLUSTER_ID"],
      capabilities: ["customImage", "ports", "fileList", "extendTimeout"],
      // Containers on per-customer VM nodes: the sandbox-to-sandbox wall is the container.
      isolation: "container",
      freeTier: {
        tier: { kind: "none" },
        notes: "No free tier: a sandbox cluster's nodes are billed by the hour from creation, idle or not.",
        source: "https://nirvanalabs.io/pricing",
        checked: "2026-11-21",
      },
      pricing: { vcpuSecondUsd: 0.016 / 3600, gibSecondUsd: 0.004 / 3600, defaultCpu: 2, defaultMemoryMiB: 4096, source: "https://nirvanalabs.io/md" },
      surfaces: {
        rest: "https://api.nirvanalabs.io/v1/sandboxes (OpenSandbox lifecycle) + /v1/sandbox_clusters",
        sdk: ["@alibaba-group/opensandbox (npm)", "opensandbox (PyPI)", "@nirvana-labs/nirvana (npm, clusters)"],
        cli: "nirvana",
        mcp: "@nirvana-labs/nirvana-mcp",
      },
    },
    base: (ctx) => opensandboxBase(String(ctx.env["NIRVANA_API_URL"] ?? "https://api.nirvanalabs.io")),
    auth: (ctx) => ({ "OPEN-SANDBOX-API-KEY": String(ctx.env["NIRVANA_API_KEY"] ?? "") }),
    extensions: (ctx) => ({ "nirvana.sandbox_cluster_id": String(ctx.env["NIRVANA_SANDBOX_CLUSTER_ID"] ?? "") }),
    // Creating from snapshots is rejected, so a native template is an image.
    templateIs: "image",
    pause: false,
  }),
);
