// The health check answers at /health as well as /healthz: Cloud Run's front end answers paths
// ending in "z" itself with a 404, so a deployed back is only reachable at /health.
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, fixture } from "./helpers.js";

afterEach(closeAll);

describe("health", () => {
  it("answers at /health and /healthz without a key, after querying the database", async () => {
    const f = await fixture();
    for (const path of ["/health", "/healthz"]) {
      const r = await f.call<{ ok: boolean }>("GET", path, { token: "" });
      expect(r).toMatchObject({ status: 200, body: { ok: true } });
    }
  });
});
