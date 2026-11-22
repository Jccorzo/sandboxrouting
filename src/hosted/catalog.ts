// The providers the hosted router runs, and what each one takes from a person: its secrets (API
// keys) and the few non-secret settings it allows. One definition, read by back (to validate a
// save), the dashboard (to draw the form) and the hosted router (to build each account's env).
//
// A provider is listed only after an audit for running many people's keys in one process:
//   - plain HTTP through the adapter's own fetch calls, to the provider's fixed hosts;
//   - credentials that are values (an API key), never a file path, a profile or a CLI login;
//   - no state shared between callers that is keyed without the caller's credentials.
// Variables that move an adapter to another host (`*_API_URL`, `*_BASE_URL`, `*_DOMAIN`, …) are
// never accepted: on a shared server they would point it at internal addresses.

import type { ProviderAdapter } from "../core/types.js";
import { daytonaProvider } from "../providers/daytona.js";
import { digitaloceanProvider } from "../providers/digitalocean.js";
import { e2bProvider } from "../providers/e2b.js";
import { freestyleProvider } from "../providers/freestyle.js";
import { koyebProvider } from "../providers/koyeb.js";
import { renderProvider } from "../providers/render.js";
import { runloopProvider } from "../providers/runloop.js";
import { spritesProvider } from "../providers/sprites.js";
import { tensorlakeProvider } from "../providers/tensorlake.js";
import { upstashProvider } from "../providers/upstash.js";

import type { CatalogEntry, CatalogField } from "./catalog-types.js";

export type { CatalogEntry, CatalogField };

interface Listed {
  adapter: ProviderAdapter;
  fields: CatalogField[];
}

const key = (name: string, label = "API key"): CatalogField => ({ name, kind: "secret", label, required: true });

const LISTED: Listed[] = [
  { adapter: e2bProvider, fields: [key("E2B_API_KEY")] },
  {
    adapter: daytonaProvider,
    fields: [
      key("DAYTONA_API_KEY"),
      { name: "DAYTONA_TARGET", kind: "setting", label: "Region", required: false, pattern: "^[a-z]{2,10}$", help: "Where sandboxes run, e.g. us or eu. Default: your organization's." },
    ],
  },
  { adapter: runloopProvider, fields: [key("RUNLOOP_API_KEY")] },
  { adapter: freestyleProvider, fields: [key("FREESTYLE_API_KEY")] },
  { adapter: spritesProvider, fields: [key("SPRITES_TOKEN", "API token")] },
  { adapter: upstashProvider, fields: [key("UPSTASH_BOX_API_KEY")] },
  {
    adapter: renderProvider,
    fields: [key("RENDER_API_KEY"), { name: "RENDER_WORKSPACE_ID", kind: "setting", label: "Workspace ID", required: true, pattern: "^[A-Za-z0-9_-]{1,64}$", help: "Starts with tea-." }],
  },
  { adapter: digitaloceanProvider, fields: [key("DIGITALOCEAN_TOKEN", "API token")] },
  { adapter: tensorlakeProvider, fields: [key("TENSORLAKE_API_KEY")] },
  { adapter: koyebProvider, fields: [key("KOYEB_API_TOKEN", "API token")] },
];

export const HOSTED_CATALOG: readonly CatalogEntry[] = LISTED.map(({ adapter, fields }) => ({
  id: adapter.info.id,
  name: adapter.info.name,
  homepage: adapter.info.homepage,
  fields,
}));

/** The adapters behind the catalog, for the hosted router. */
export const hostedAdapters = (): ProviderAdapter[] => LISTED.map((l) => l.adapter);

export const catalogEntry = (id: string): CatalogEntry | undefined => HOSTED_CATALOG.find((e) => e.id === id);

export type CredentialCheck = { ok: true; values: Record<string, string> } | { ok: false; message: string };

/** Checks what someone typed against the catalog: every required field, nothing it doesn't know. */
export function checkCredentials(id: string, input: unknown): CredentialCheck {
  const entry = catalogEntry(id);
  if (!entry) return { ok: false, message: `${id} isn't a provider the hosted router runs` };
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, message: "send values as { VARIABLE: value }" };
  const given = input as Record<string, unknown>;
  const known = new Map(entry.fields.map((f) => [f.name, f]));
  for (const name of Object.keys(given)) {
    if (!known.has(name)) return { ok: false, message: `${entry.name} doesn't take ${name}` };
  }
  const values: Record<string, string> = {};
  for (const f of entry.fields) {
    const raw = given[f.name];
    const v = typeof raw === "string" ? raw.trim() : raw;
    if (v === undefined || v === "") {
      if (f.required) return { ok: false, message: `${f.label} (${f.name}) is required` };
      continue;
    }
    if (typeof v !== "string") return { ok: false, message: `${f.name} must be text` };
    if (v.length > 4096 || /[\r\n\0]/.test(v)) return { ok: false, message: `${f.name} doesn't look right (too long, or has line breaks)` };
    if (f.pattern && !new RegExp(f.pattern).test(v)) return { ok: false, message: `${f.label} (${f.name}) doesn't look right` };
    values[f.name] = v;
  }
  return { ok: true, values };
}

/** What a list shows of saved values: a secret's last 4 characters, a setting in full. */
export function credentialHints(id: string, values: Record<string, string>): Record<string, string> {
  const entry = catalogEntry(id);
  const out: Record<string, string> = {};
  for (const f of entry?.fields ?? []) {
    const v = values[f.name];
    if (v === undefined) continue;
    out[f.name] = f.kind === "secret" ? (v.length > 8 ? `…${v.slice(-4)}` : "…") : v;
  }
  return out;
}
