// Bundles back into dist/: the server (main.js), the account CLI (cli.js) and the hosted router (hosted.js). The router's own
// definitions it imports from ../src are bundled in; npm packages stay external, so the image
// installs them with `npm ci --omit=dev`.
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const router = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const external = [...Object.keys(pkg.dependencies ?? {}), "@electric-sql/pglite"];

await build({
  // hosted.js: the hosted router, a second service from the same image (src/hosted-router/).
  entryPoints: { main: "src/main.ts", cli: "src/cli.ts", hosted: "src/hosted-router/main.ts" },
  define: { __SBR_ROUTER_VERSION__: JSON.stringify(router.version) },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  external,
  logLevel: "warning",
});
