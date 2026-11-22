import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The workspace root: dependencies are hoisted there, and the data generator reads the router
// sources there. Named explicitly so Next doesn't guess from some lockfile further up.
const root = fileURLToPath(new URL("..", import.meta.url));

// A static site: `next build` writes plain files to out/, which any static host serves.
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
  // The repository keeps its own AGENTS.md; next dev would add another under web/.
  agentRules: false,
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default config;
