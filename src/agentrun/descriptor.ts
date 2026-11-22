// sandboxrouting's descriptor for AgentRun (AgentRun's src/descriptors/<id>.ts, data and a lazy load() alone): one
// provider that routes each computer to one of sandboxrouting's providers, free usage first by default, and fails over
// when one refuses. Its machines dial the server (MachineHost facts.connect "dial"): sandboxrouting's exec answers once
// the command ends, which can't carry AgentRun's stdio bridge, so each machine's agentrun-dial dials the server's
// attach route instead, as Fly Machines' do (AgentRun's src/descriptors/fly.ts).
import { defineProvider } from "./agentrun-computer.js";

/**
 * The server's environment variables the router reads, which a server passes as options.env (descriptor hostEnv):
 * sandboxrouting's own (SBR_CONFIG names its config file, SBR_HOME its ledger's folder, SBR_ALLOW_PAID) and every
 * built-in provider's info.env, the keys it routes with. test/agentrun.test.ts holds this list to builtinProviders().
 * An adapter's optional variables (a base URL, a region) are not here: give them through options.env.
 */
export const SANDBOXROUTING_ENV = [
  "SBR_CONFIG", "SBR_HOME", "SBR_ALLOW_PAID",
  "AAS_API_KEY", "AGENT37_API_KEY", "AGENTAL_API_KEY", "AGENTBAY_API_KEY", "AGENT_SANDBOX_K8S_API", "AGENT_SANDBOX_ROUTER_URL",
  "AGENT_SANDBOX_WARM_POOL", "ARCHIL_API_KEY", "AZURE_REGION", "AZURE_RESOURCE_GROUP", "AZURE_SANDBOX_GROUP", "AZURE_SUBSCRIPTION_ID",
  "BASETEN_API_KEY", "BEAM_TOKEN", "BEAM_WORKSPACE_ID", "BL_API_KEY", "BL_WORKSPACE", "BOAT_API_KEY", "BOXCOMPUTE_API_KEY",
  "BOXD_API_KEY", "BOXLITE_API_KEY", "BRIQ_API_KEY", "BUDDY_PROJECT", "BUDDY_TOKEN", "BUDDY_WORKSPACE", "CATHEDRAL_API_KEY",
  "CELESTO_API_KEY", "CHALK_CLIENT_ID", "CHALK_CLIENT_SECRET", "CLOUDFLARE_SANDBOX_TOKEN", "CLOUDFLARE_SANDBOX_URL",
  "CLOUD_RUN_REGION", "CLOUD_RUN_SANDBOX_IMAGE", "CREATEOS_SANDBOX_API_KEY", "CYQLE_API_KEY", "DAYTONA_API_KEY", "DEDALUS_API_KEY",
  "DEPOT_TOKEN", "DIGITALOCEAN_TOKEN", "DOCKER_ID", "DOCKER_PAT", "DORY_API_KEY", "E2B_API_KEY", "EQVPS_API_KEY", "EXE_API_TOKEN",
  "FLY_API_TOKEN", "FLY_APP", "FREESTYLE_API_KEY", "GMI_SANDBOX_API_KEY", "GMI_SANDBOX_TEMPLATE", "GOOGLE_CLOUD_PROJECT",
  "GROUNDBOX_API_KEY", "HYPERBROWSER_API_KEY", "INNGEST_SIGNING_KEY", "INSTABOX_API_KEY", "INSTAVM_API_KEY", "ISLO_API_KEY",
  "ISORUN_API_KEY", "KELN_API_KEY", "KOSA8_API_KEY", "KOYEB_API_TOKEN", "KUBI_API_KEY", "LAMBDA_MICROVM_IMAGE", "LANGSMITH_API_KEY",
  "LIZARD_API_KEY", "LIZARD_PROJECT_ID", "LUXOR_API_KEY", "MACHINE0_API_KEY", "MANDALA_API_KEY", "MARITIME_API_KEY", "MIOSA_API_KEY",
  "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MORPH_API_KEY", "MOSAIC_API_TOKEN", "MUNITO_API_KEY", "NANITE_API_KEY", "NIRVANA_API_KEY",
  "NIRVANA_SANDBOX_CLUSTER_ID", "NODUS_API_KEY", "NODUS_PROJECT", "NORTHFLANK_PROJECT", "NORTHFLANK_TOKEN", "NOVITA_API_KEY",
  "NSC_TOKEN", "OBLIEN_CLIENT_ID", "OBLIEN_CLIENT_SECRET", "OFFSTAGE_API_KEY", "OPENCI_TOKEN", "OPENCI_URL", "OPENPOND_API_KEY",
  "OPENREWARD_API_KEY", "OPENREWARD_ENVIRONMENT", "OPEN_SANDBOX_DOMAIN", "ORBLE_API_KEY", "PILLDROPS_API_KEY", "PRIME_API_KEY",
  "PRIZED_API_KEY", "PROMIGENCE_API_KEY", "PT_TOKEN", "QUAVEONE_ACCOUNT_ID", "QUAVEONE_APP_ID", "QUAVEONE_SANDBOX_TEMPLATE_ID",
  "QUAVEONE_USER_TOKEN", "QUIVVO_API_KEY", "RAILWAY_TOKEN", "RAYRUN_TOKEN", "RENDER_API_KEY", "RENDER_WORKSPACE_ID", "RUNLOOP_API_KEY",
  "RUNTA_API_KEY", "RUNTIME_API_KEY", "SANDBOX0_TOKEN", "SANDBOXER_API_KEY", "SMOL_CLOUD_TOKEN", "SOLARI_API_KEY", "SPRITES_TOKEN",
  "STATESET_API_KEY", "SUPERSERVE_API_KEY", "TAMA_TOKEN", "TANGLE_API_KEY", "TENCENT_AGS_API_KEY", "TENCENT_AGS_TOOL",
  "TENSORLAKE_API_KEY", "TNR_API_TOKEN", "TOGETHER_API_KEY", "TZAFON_API_KEY", "UPSTASH_BOX_API_KEY", "VERCEL_PROJECT_ID",
  "VERCEL_TEAM_ID", "VERCEL_TOKEN", "VERS_API_KEY", "VOIDRUN_API_KEY", "VOLCENGINE_E2B_API_KEY", "VOLCENGINE_E2B_TEMPLATE_ID",
  "WATASU_API_KEY", "WORKPAPER_API_KEY", "ZIPBOX_API_KEY", "ZODE_API_KEY",
] as const;

export const SANDBOXROUTING = defineProvider({
  id: "sandboxrouting",
  label: "sandboxrouting",
  // None of its own: the router's keys are its providers', read from the server's environment (hostEnv).
  keys: [],
  // Each setting's empty default leaves the choice to sandboxrouting's config file (SBR_CONFIG), else its defaults.
  settings: [
    // free-first (sandboxrouting's default), cheapest, balanced, fastest or spread: docs/routing.md.
    { name: "sandboxroutingStrategy", option: "strategy", default: "" },
    // Provider ids to route among, comma-separated, in order of preference; empty: every configured one.
    { name: "sandboxroutingProviders", option: "providers", default: "" },
    // Provider ids never to route to, comma-separated.
    { name: "sandboxroutingExclude", option: "exclude", default: "" },
    // The weakest isolation a computer may get: container, gvisor, microvm or vm.
    { name: "sandboxroutingMinIsolation", option: "minIsolation", default: "" },
    // "true" lets the router pay once free usage is gone; "false" holds it to free tiers.
    { name: "sandboxroutingAllowPaid", option: "allowPaid", default: "" },
    // The most paid spend per calendar month, in USD, across providers, when paid usage is allowed.
    { name: "sandboxroutingMaxPaidUsdPerMonth", option: "maxPaidUsdPerMonth", default: "" },
  ],
  metered: true,
  connect: "dial",
  // None: a machine that dials takes no Archil mount (mountsOf).
  mounts: [],
  // init's fence and egress proxy enforce all three (AgentRun's hosted/network.ts) where root can make a network
  // namespace, which the launch checks before agentrun-dial starts; a sandbox where it can't is deleted and the router
  // tries the next provider.
  network: ["none", "open", "allow"],
  capabilities: [{ kind: "linux", groups: ["exec", "files", "processes"] }],
  // Every computer starts from the box image its prepareImage() answers.
  prepareImage: true,
  hostEnv: SANDBOXROUTING_ENV,
  load: () => import("./index.js"),
});
