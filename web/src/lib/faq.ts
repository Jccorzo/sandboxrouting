// Questions people ask before using the router, answered from README.md and docs/routing.md.
// Numbers come from the generated data, so an answer can't keep a number the router changed.

import { site } from "./data";

const cb = site.defaults.circuitBreaker;

/** How long each refusal benched its provider in the generated failover example (seconds). */
export function benchFor(kind: string): number | undefined {
  return site.failover[0]?.attempts.find((a) => a.kind === kind)?.untilSec;
}

/** The quota recheck backoff the router produced, in days: 1, 2, 4, 7, … */
export const quotaBackoffDays = [...new Set(site.quota.map((p) => p.untilDay - p.atDay))];

const minutes = (sec: number | undefined) => (sec === undefined ? "a while" : sec < 120 ? `${sec / 60 === 1 ? "a minute" : `${sec} seconds`}` : `${sec / 60} minutes`);
const days = quotaBackoffDays.map(String);
const backoff = `${days.slice(0, -1).join(", ")} and then ${days.at(-1)} days`;

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Will it ever bill me?",
    a: "Not unless you say so. Paid usage is off by default (allowPaid: false): a request no free tier can take fails with every provider's reason. Turn it on globally or per provider, and set maxPaidUsdPerMonth to make the month's spend a hard cap.",
  },
  {
    q: "How does it know how much free usage is left?",
    a: "It meters locally. No provider has an API that reports remaining free credit, so every sandbox's running time is recorded in a ledger and priced at the provider's rates. Live sandboxes reserve what they can still spend, so a free tier only takes a request it can cover whole.",
  },
  {
    q: "What if I already used some credit elsewhere?",
    a: "The router can't see usage outside it. Set usedBeforeUsd for a one-time credit you have partly spent. If a provider refuses for quota anyway, a 402 marks its free tier as used up and the router moves on.",
  },
  {
    q: "What happens when a provider refuses?",
    a: `The router tries the next provider in the plan and marks the one that refused: a 429 is skipped for ${minutes(benchFor("rate_limit"))}, a 401 or 403 for ${minutes(benchFor("auth"))}, and a 402 until its monthly reset, or for ${backoff}. Network errors and 5xx count toward a circuit breaker: ${cb.failures} in a row open it for ${cb.cooldownSec / 60} minutes, doubling up to ${cb.maxCooldownSec / 60}.`,
  },
  {
    q: "Can I pick the order myself?",
    a: `Yes. The default strategy is ${site.defaults.strategy}; ${site.strategies.length} are built in (${site.strategies.map((s) => s.name).join(", ")}), you can choose one in config or per request, set a priority per provider, or register your own. No strategy can route around the hard rules: keys, capabilities, isolation, allowPaid and budgets.`,
  },
  {
    q: "What happens to my work when a box dies?",
    a: "Run it as a job: ordered steps plus a working directory, checkpointed after each step. When a box vanishes, its provider refuses or a limit is about to end it, the job continues on another box from the last checkpoint. Steps with outside effects are marked idempotent: false, so they never run twice.",
  },
  {
    q: "How are sandboxes isolated?",
    a: "Each provider declares its isolation: container, gVisor, microVM or VM. Ask for minIsolation and weaker or unknown providers are skipped. Several providers don't publish theirs, and those never match a minIsolation request.",
  },
  {
    q: "Where is the state kept?",
    a: "In one ledger file, ~/.sandboxrouting/ledger.json, locked for every update and written whole. The SDK, the CLI, the REST server and the MCP server share it, so they agree on what is live and what is spent.",
  },
  {
    q: "Is it affiliated with the providers?",
    a: "No. sandboxrouting isn't affiliated with or endorsed by any provider it supports. Free tiers and prices are as each adapter's source page said on its checked date; check a provider's own terms before you rely on them, and override them in config when yours differ.",
  },
];
