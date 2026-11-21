// Every built-in provider. To add one: write src/providers/<id>.ts with `defineProvider`,
// then add it to this list (or call `router.register(adapter)` from your own code).
// The order here only breaks ties; the routing policy decides who goes first.

import type { ProviderAdapter } from "../core/types.js";
import { agent37Provider } from "./agent37.js";
import { beamProvider } from "./beam.js";
import { blaxelProvider } from "./blaxel.js";
import { boatProvider } from "./boat.js";
import { boxcomputeProvider } from "./boxcompute.js";
import { boxdProvider } from "./boxd.js";
import { boxliteProvider } from "./boxlite.js";
import { buddyProvider } from "./buddy.js";
import { cathedralProvider } from "./cathedral.js";
import { celestoProvider } from "./celesto.js";
import { cloudflareProvider } from "./cloudflare.js";
import { createosProvider } from "./createos.js";
import { daytonaProvider } from "./daytona.js";
import { dedalusProvider } from "./dedalus.js";
import { depotProvider } from "./depot.js";
import { dockerProvider } from "./docker.js";
import { doryProvider } from "./dory.js";
import { e2bProvider } from "./e2b.js";
import { exedevProvider } from "./exedev.js";
import { flyProvider } from "./fly.js";
import { freestyleProvider } from "./freestyle.js";
import { instaboxProvider } from "./instabox.js";
import { instavmProvider } from "./instavm.js";
import { isorunProvider } from "./isorun.js";
import { koyebProvider } from "./koyeb.js";
import { lambdaMicrovmProvider } from "./lambda-microvm.js";
import { lizardProvider } from "./lizard.js";
import { maritimeProvider } from "./maritime.js";
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
import { prizedProvider } from "./prized.js";
import { promigenceProvider } from "./promigence.js";
import { quaveProvider } from "./quave.js";
import { quivvoProvider } from "./quivvo.js";
import { renderProvider } from "./render.js";
import { runloopProvider } from "./runloop.js";
import { smolProvider } from "./smol.js";
import { spritesProvider } from "./sprites.js";
import { tenkiProvider } from "./tenki.js";
import { tensorlakeProvider } from "./tensorlake.js";
import { thunderProvider } from "./thunder.js";
import { togetherProvider } from "./together.js";
import { upstashProvider } from "./upstash.js";
import { vercelProvider } from "./vercel.js";
import { zipboxProvider } from "./zipbox.js";
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
    novitaProvider,
    smolProvider,
    isorunProvider,
    instavmProvider,
    prizedProvider,
    zipboxProvider,
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
    // Your own hardware.
    openciProvider,
    opensandboxProvider,
    dockerProvider,
  ];
}

export {
  agent37Provider,
  beamProvider,
  blaxelProvider,
  boatProvider,
  boxcomputeProvider,
  boxdProvider,
  boxliteProvider,
  buddyProvider,
  cathedralProvider,
  celestoProvider,
  cloudflareProvider,
  createosProvider,
  daytonaProvider,
  dedalusProvider,
  depotProvider,
  dockerProvider,
  doryProvider,
  e2bProvider,
  exedevProvider,
  flyProvider,
  freestyleProvider,
  instaboxProvider,
  instavmProvider,
  isorunProvider,
  koyebProvider,
  lambdaMicrovmProvider,
  lizardProvider,
  maritimeProvider,
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
  prizedProvider,
  promigenceProvider,
  quaveProvider,
  quivvoProvider,
  renderProvider,
  runloopProvider,
  smolProvider,
  spritesProvider,
  tenkiProvider,
  tensorlakeProvider,
  thunderProvider,
  togetherProvider,
  upstashProvider,
  vercelProvider,
  zipboxProvider,
  zodeProvider,
};
