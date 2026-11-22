import { readFileSync } from "node:fs";

/** sandboxrouting's version, read from its own package.json: the one place it is written. */
export function packageVersion(): string {
  // src/version.ts and dist/version.js both sit one level below package.json.
  cached ??= (
    JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string }
  ).version;
  return cached;
}
let cached: string | undefined;
