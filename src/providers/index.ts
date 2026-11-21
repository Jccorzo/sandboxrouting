// Every built-in provider. To add one: write src/providers/<id>.ts with `defineProvider`,
// then add it to this list (or call `router.register(adapter)` from your own code).
// The order here only breaks ties; the routing policy decides who goes first.

import type { ProviderAdapter } from "../core/types.js";
import { agent37Provider } from "./agent37.js";
import { azureSessionsProvider } from "./azure-sessions.js";
import { agentbayProvider } from "./agentbay.js";
import { beamProvider } from "./beam.js";
import { blaxelProvider } from "./blaxel.js";
import { boatProvider } from "./boat.js";
import { boxcomputeProvider } from "./boxcompute.js";
import { boxdProvider } from "./boxd.js";
import { boxliteProvider } from "./boxlite.js";
import { briqProvider } from "./briq.js";
import { buddyProvider } from "./buddy.js";
import { cathedralProvider } from "./cathedral.js";
import { celestoProvider } from "./celesto.js";
import { cloudflareProvider } from "./cloudflare.js";
import { cloudrunProvider } from "./cloudrun.js";
import { createosProvider } from "./createos.js";
import { daytonaProvider } from "./daytona.js";
import { dedalusProvider } from "./dedalus.js";
import { depotProvider } from "./depot.js";
import { digitaloceanProvider } from "./digitalocean.js";
import { dockerCloudProvider } from "./docker-cloud.js";
import { dockerProvider } from "./docker.js";
import { doryProvider } from "./dory.js";
import { e2bProvider } from "./e2b.js";
import { eqvpsProvider } from "./eqvps.js";
import { exedevProvider } from "./exedev.js";
import { flyProvider } from "./fly.js";
import { freestyleProvider } from "./freestyle.js";
import { groundboxProvider } from "./groundbox.js";
import { gkeAgentSandboxProvider } from "./gke-agent-sandbox.js";
import { instaboxProvider } from "./instabox.js";
import { instavmProvider } from "./instavm.js";
import { isorunProvider } from "./isorun.js";
import { koyebProvider } from "./koyeb.js";
import { kubiProvider } from "./kubi.js";
import { lambdaMicrovmProvider } from "./lambda-microvm.js";
import { langsmithProvider } from "./langsmith.js";
import { lizardProvider } from "./lizard.js";
import { maritimeProvider } from "./maritime.js";
import { miosaProvider } from "./miosa.js";
import { modalProvider } from "./modal.js";
import { morphProvider } from "./morph.js";
import { mosaicProvider } from "./mosaic.js";
import { munitoProvider } from "./munito.js";
import { namespaceProvider } from "./namespace.js";
import { naniteProvider } from "./nanite.js";
import { nodusProvider } from "./nodus.js";
import { northflankProvider } from "./northflank.js";
import { novitaProvider } from "./novita.js";
import { openciProvider } from "./openci.js";
import { opensandboxProvider } from "./opensandbox.js";
import { orbleProvider } from "./orble.js";
import { prizedProvider } from "./prized.js";
import { pilldropsProvider } from "./pilldrops.js";
import { promigenceProvider } from "./promigence.js";
import { quaveProvider } from "./quave.js";
import { quivvoProvider } from "./quivvo.js";
import { railwayProvider } from "./railway.js";
import { renderProvider } from "./render.js";
import { runloopProvider } from "./runloop.js";
import { runtimeProvider } from "./runtime.js";
import { smolProvider } from "./smol.js";
import { solariProvider } from "./solari.js";
import { spritesProvider } from "./sprites.js";
import { superserveProvider } from "./superserve.js";
import { tenkiProvider } from "./tenki.js";
import { tencentProvider } from "./tencent.js";
import { tensorlakeProvider } from "./tensorlake.js";
import { thunderProvider } from "./thunder.js";
import { togetherProvider } from "./together.js";
import { upstashProvider } from "./upstash.js";
import { vercelProvider } from "./vercel.js";
import { zipboxProvider } from "./zipbox.js";
import { volcengineProvider } from "./volcengine.js";
import { zodeProvider } from "./zode.js";

export function builtinProviders(): ProviderAdapter[] {
  return [
    // Monthly free usage.
    modalProvider,
    northflankProvider,
    freestyleProvider,
    vercelProvider,
    instaboxProvider,
    upstashProvider,
    cloudflareProvider,
    tensorlakeProvider,
    buddyProvider,
    solariProvider,
    langsmithProvider,
    miosaProvider,
    cloudrunProvider,
    azureSessionsProvider,
    // One-time credit.
    daytonaProvider,
    blaxelProvider,
    e2bProvider,
    tenkiProvider,
    boxliteProvider,
    runloopProvider,
    dedalusProvider,
    createosProvider,
    quivvoProvider,
    celestoProvider,
    agent37Provider,
    boatProvider,
    boxdProvider,
    maritimeProvider,
    promigenceProvider,
    zodeProvider,
    boxcomputeProvider,
    lizardProvider,
    munitoProvider,
    groundboxProvider,
    briqProvider,
    runtimeProvider,
    dockerCloudProvider,
    novitaProvider,
    smolProvider,
    isorunProvider,
    instavmProvider,
    prizedProvider,
    zipboxProvider,
    pilldropsProvider,
    railwayProvider,
    // Paid only.
    koyebProvider,
    flyProvider,
    spritesProvider,
    morphProvider,
    togetherProvider,
    depotProvider,
    namespaceProvider,
    lambdaMicrovmProvider,
    thunderProvider,
    exedevProvider,
    naniteProvider,
    renderProvider,
    quaveProvider,
    beamProvider,
    mosaicProvider,
    nodusProvider,
    cathedralProvider,
    doryProvider,
    kubiProvider,
    orbleProvider,
    digitaloceanProvider,
    superserveProvider,
    eqvpsProvider,
    gkeAgentSandboxProvider,
    agentbayProvider,
    tencentProvider,
    volcengineProvider,
    // Your own hardware.
    openciProvider,
    opensandboxProvider,
    dockerProvider,
  ];
}

export {
  agent37Provider,
  azureSessionsProvider,
  agentbayProvider,
  beamProvider,
  blaxelProvider,
  boatProvider,
  boxcomputeProvider,
  boxdProvider,
  boxliteProvider,
  briqProvider,
  buddyProvider,
  cathedralProvider,
  celestoProvider,
  cloudflareProvider,
  cloudrunProvider,
  createosProvider,
  daytonaProvider,
  dedalusProvider,
  depotProvider,
  digitaloceanProvider,
  dockerCloudProvider,
  dockerProvider,
  doryProvider,
  e2bProvider,
  eqvpsProvider,
  exedevProvider,
  flyProvider,
  freestyleProvider,
  groundboxProvider,
  gkeAgentSandboxProvider,
  instaboxProvider,
  instavmProvider,
  isorunProvider,
  koyebProvider,
  kubiProvider,
  lambdaMicrovmProvider,
  langsmithProvider,
  lizardProvider,
  maritimeProvider,
  miosaProvider,
  modalProvider,
  morphProvider,
  mosaicProvider,
  munitoProvider,
  namespaceProvider,
  naniteProvider,
  nodusProvider,
  northflankProvider,
  novitaProvider,
  openciProvider,
  opensandboxProvider,
  orbleProvider,
  prizedProvider,
  pilldropsProvider,
  promigenceProvider,
  quaveProvider,
  quivvoProvider,
  railwayProvider,
  renderProvider,
  runloopProvider,
  runtimeProvider,
  smolProvider,
  solariProvider,
  spritesProvider,
  superserveProvider,
  tencentProvider,
  tenkiProvider,
  tensorlakeProvider,
  thunderProvider,
  togetherProvider,
  upstashProvider,
  vercelProvider,
  zipboxProvider,
  volcengineProvider,
  zodeProvider,
};
