// Every built-in provider. To add one: write src/providers/<id>.ts with `defineProvider`,
// then add it to this list (or call `router.register(adapter)` from your own code).
// The order here only breaks ties; the routing policy decides who goes first.

import type { ProviderAdapter } from "../core/types.js";
import { agent37Provider } from "./agent37.js";
import { blaxelProvider } from "./blaxel.js";
import { boatProvider } from "./boat.js";
import { boxliteProvider } from "./boxlite.js";
import { celestoProvider } from "./celesto.js";
import { cloudflareProvider } from "./cloudflare.js";
import { createosProvider } from "./createos.js";
import { daytonaProvider } from "./daytona.js";
import { dedalusProvider } from "./dedalus.js";
import { depotProvider } from "./depot.js";
import { dockerProvider } from "./docker.js";
import { e2bProvider } from "./e2b.js";
import { exedevProvider } from "./exedev.js";
import { flyProvider } from "./fly.js";
import { freestyleProvider } from "./freestyle.js";
import { instaboxProvider } from "./instabox.js";
import { koyebProvider } from "./koyeb.js";
import { lambdaMicrovmProvider } from "./lambda-microvm.js";
import { modalProvider } from "./modal.js";
import { morphProvider } from "./morph.js";
import { namespaceProvider } from "./namespace.js";
import { northflankProvider } from "./northflank.js";
import { openciProvider } from "./openci.js";
import { quivvoProvider } from "./quivvo.js";
import { runloopProvider } from "./runloop.js";
import { spritesProvider } from "./sprites.js";
import { tenkiProvider } from "./tenki.js";
import { thunderProvider } from "./thunder.js";
import { togetherProvider } from "./together.js";
import { upstashProvider } from "./upstash.js";
import { vercelProvider } from "./vercel.js";

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
    // Your own hardware.
    openciProvider,
    dockerProvider,
  ];
}

export {
  agent37Provider,
  blaxelProvider,
  boatProvider,
  boxliteProvider,
  celestoProvider,
  cloudflareProvider,
  createosProvider,
  daytonaProvider,
  dedalusProvider,
  depotProvider,
  dockerProvider,
  e2bProvider,
  exedevProvider,
  flyProvider,
  freestyleProvider,
  instaboxProvider,
  koyebProvider,
  lambdaMicrovmProvider,
  modalProvider,
  morphProvider,
  namespaceProvider,
  northflankProvider,
  openciProvider,
  quivvoProvider,
  runloopProvider,
  spritesProvider,
  tenkiProvider,
  thunderProvider,
  togetherProvider,
  upstashProvider,
  vercelProvider,
};
