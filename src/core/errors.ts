// Error kinds the router acts on. Adapters throw whatever their SDK throws; `classify`
// turns it into one of these so failover decisions live in one place.

export type ErrorKind =
  | "quota" // free credit or plan limit used up: mark exhausted until the period resets
  | "rate_limit" // too many requests or concurrent sandboxes: cool down briefly
  | "auth" // bad or missing key: skip until config changes
  | "not_found" // the sandbox is gone
  | "unsupported" // the adapter cannot do this
  | "invalid" // the request itself is wrong: do not fail over
  | "transient"; // network, 5xx, timeouts: try the next provider

export class SandboxRouterError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    message: string,
    public readonly provider?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SandboxRouterError";
  }
}

export class NoProviderAvailableError extends SandboxRouterError {
  constructor(public readonly attempts: RouteAttempt[]) {
    super(
      "invalid",
      "No sandbox provider could take this request.\n" +
        attempts.map((a) => `  - ${a.provider}: ${a.outcome}${a.detail ? ` (${a.detail})` : ""}`).join("\n"),
    );
    this.name = "NoProviderAvailableError";
  }
}

export interface RouteAttempt {
  provider: string;
  outcome: "created" | "skipped" | "failed";
  detail?: string;
  kind?: ErrorKind;
}

function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  for (const key of ["status", "statusCode", "code"]) {
    const v = e[key];
    if (typeof v === "number" && v >= 100 && v < 600) return v;
  }
  const response = e["response"] as Record<string, unknown> | undefined;
  if (response && typeof response["status"] === "number") return response["status"] as number;
  return undefined;
}

const QUOTA = /(quota|credit|insufficient (funds|balance)|payment required|billing|out of (credits|minutes|hours)|plan limit|usage limit|exceeded your|upgrade your plan|spend limit)/i;
const RATE = /(rate.?limit|too many (requests|sandboxes)|concurren|max(imum)? (number of )?(running|active) sandboxes)/i;
const AUTH = /(unauthori[sz]ed|invalid (api )?key|api key|forbidden|authentication|not authenticated|missing token)/i;
const NOT_FOUND = /(not found|does not exist|no such sandbox|404)/i;

export function classify(err: unknown, provider?: string): SandboxRouterError {
  if (err instanceof SandboxRouterError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const status = statusOf(err);
  let kind: ErrorKind = "transient";
  if (status === 402) kind = "quota";
  else if (status === 429) kind = QUOTA.test(message) ? "quota" : "rate_limit";
  else if (status === 401 || status === 403) kind = QUOTA.test(message) ? "quota" : "auth";
  else if (status === 404) kind = "not_found";
  else if (status === 400 || status === 422) kind = QUOTA.test(message) ? "quota" : "invalid";
  else if (QUOTA.test(message)) kind = "quota";
  else if (RATE.test(message)) kind = "rate_limit";
  else if (AUTH.test(message)) kind = "auth";
  else if (NOT_FOUND.test(message)) kind = "not_found";
  return new SandboxRouterError(kind, message, provider, { cause: err });
}
