// The Routing page's form over the hosted router's config. The form edits a few fields; saving
// writes them into the config as it was loaded, so fields it doesn't show are kept as they are.
// Pure, so it is tested without a browser.

export interface RoutingForm {
  strategy: string;
  allowPaid: boolean;
  /** Text as typed: "" means no cap. */
  maxPaidUsdPerMonth: string;
  /** Per provider: off (enabled: false) and its priority as typed ("" means the default). */
  providers: Record<string, { enabled: boolean; priority: string }>;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});

export function formFromConfig(config: Obj, providerIds: string[], defaultStrategy: string): RoutingForm {
  const routing = obj(config["routing"]);
  const providers = obj(config["providers"]);
  return {
    strategy: typeof routing["strategy"] === "string" ? routing["strategy"] : typeof config["policy"] === "string" ? config["policy"] : defaultStrategy,
    allowPaid: config["allowPaid"] === true,
    maxPaidUsdPerMonth: typeof config["maxPaidUsdPerMonth"] === "number" ? String(config["maxPaidUsdPerMonth"]) : "",
    providers: Object.fromEntries(
      providerIds.map((id) => {
        const p = obj(providers[id]);
        return [id, { enabled: p["enabled"] !== false, priority: typeof p["priority"] === "number" ? String(p["priority"]) : "" }];
      }),
    ),
  };
}

export type Built = { ok: true; config: Obj } | { ok: false; message: string };

/** The loaded config with the form's fields written in. */
export function configFromForm(base: Obj, form: RoutingForm): Built {
  const out: Obj = structuredClone(base);
  const routing = { ...obj(out["routing"]), strategy: form.strategy };
  out["routing"] = routing;
  delete out["policy"];
  if (form.allowPaid) out["allowPaid"] = true;
  else delete out["allowPaid"];
  const cap = form.maxPaidUsdPerMonth.trim();
  if (cap === "") delete out["maxPaidUsdPerMonth"];
  else {
    const n = Number(cap);
    if (!Number.isFinite(n) || n < 0) return { ok: false, message: "The monthly cap must be a number of dollars, 0 or more." };
    out["maxPaidUsdPerMonth"] = n;
  }
  const providers: Obj = { ...obj(out["providers"]) };
  for (const [id, f] of Object.entries(form.providers)) {
    const p: Obj = { ...obj(providers[id]) };
    if (f.enabled) delete p["enabled"];
    else p["enabled"] = false;
    const pr = f.priority.trim();
    if (pr === "") delete p["priority"];
    else {
      const n = Number(pr);
      if (!Number.isFinite(n)) return { ok: false, message: `The priority for ${id} must be a number.` };
      p["priority"] = n;
    }
    if (Object.keys(p).length) providers[id] = p;
    else delete providers[id];
  }
  if (Object.keys(providers).length) out["providers"] = providers;
  else delete out["providers"];
  return { ok: true, config: out };
}
