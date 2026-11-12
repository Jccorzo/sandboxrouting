// Routing strategies by name: the built-ins plus any you register. A name picks exactly one
// strategy; an unknown one is a request error, never a silent fallback.

import { SandboxRouterError } from "../errors.js";
import { builtinStrategies } from "./strategies.js";
import type { RoutingStrategy } from "./types.js";

export class StrategyRegistry {
  private readonly byName = new Map<string, RoutingStrategy>();

  constructor(initial: readonly RoutingStrategy[] = builtinStrategies()) {
    for (const s of initial) this.register(s);
  }

  register(strategy: RoutingStrategy): this {
    if (this.byName.has(strategy.name)) {
      throw new SandboxRouterError("invalid", `routing strategy "${strategy.name}" is already registered`);
    }
    this.byName.set(strategy.name, strategy);
    return this;
  }

  get(name: string): RoutingStrategy {
    const strategy = this.byName.get(name);
    if (!strategy) {
      throw new SandboxRouterError("invalid", `unknown routing strategy "${name}" (have: ${[...this.byName.keys()].join(", ")})`);
    }
    return strategy;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  list(): RoutingStrategy[] {
    return [...this.byName.values()];
  }
}
