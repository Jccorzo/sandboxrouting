// The hosted router's egress guard. Adapters call URLs that come from code and from providers'
// answers (a toolbox URL, a sandbox's host); on a shared server none of them may reach an
// internal address: the metadata server (whose token is this service's identity), the VPC, or
// localhost. Every connection fetch opens goes through one undici dispatcher whose connector
// resolves the name itself and refuses when any address it resolves to is private, link-local,
// loopback, CGNAT, multicast or reserved. The check runs at connect time on the addresses the
// socket then uses, so a name that resolves differently on a second lookup (DNS rebinding) gets
// nowhere, and redirects are checked like any other connection.

import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { Agent, buildConnector, setGlobalDispatcher } from "undici";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, the metadata server
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, and broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64: an IPv4 address in disguise
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32], // Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** An IPv4 address carried in an IPv4-mapped IPv6 one (::ffff:a.b.c.d or ::ffff:hhhh:hhhh). */
function mappedV4(address: string): string | undefined {
  const dotted = /^(?:0{0,4}:){0,5}:?ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return undefined;
  const hi = Number.parseInt(hex[1]!, 16);
  const lo = Number.parseInt(hex[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Whether the hosted router may not connect to this address. Anything that isn't an IP address is refused. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 0) return true;
  if (family === 6) {
    const v4 = mappedV4(bare);
    if (v4 !== undefined) return isBlockedAddress(v4);
  }
  return blocked.check(bare, family === 4 ? "ipv4" : "ipv6");
}

export class EgressRefused extends Error {
  readonly code = "ESBR_EGRESS";
  constructor(host: string) {
    super(`refused to connect to ${host}: it is, or resolves to, a private or internal address`);
    this.name = "EgressRefused";
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** dns.lookup, refusing a name when any address it resolves to is blocked. */
export function guardedLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (!addresses.length || addresses.some((a) => isBlockedAddress(a.address))) return callback(new EgressRefused(hostname), []);
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

/** An undici connector that refuses blocked addresses, given as IP literals or by name. */
export function guardedConnector(): buildConnector.connector {
  const base = buildConnector({ lookup: guardedLookup as never });
  return (opts, callback) => {
    const host = opts.hostname.replace(/^\[|\]$/g, "");
    // net.connect doesn't look up an IP literal, so it is checked here.
    if (isIP(host) && isBlockedAddress(host)) {
      callback(new EgressRefused(host), null);
      return;
    }
    base(opts, callback);
  };
}

/** A dispatcher whose every connection is checked. */
export function guardedAgent(): Agent {
  return new Agent({ connect: guardedConnector() });
}

/**
 * Makes the guarded dispatcher the one every fetch in this process uses: Node's own fetch reads it
 * from undici's global registry, and so does dispatcherFor (src/providers/util.ts), which adapters
 * pass for long requests. Both registry versions point at it, so it holds whichever one a given
 * Node's fetch reads. Call it before anything else fetches.
 */
export function installEgressGuard(): Agent {
  const agent = guardedAgent();
  setGlobalDispatcher(agent);
  const g = globalThis as unknown as Record<symbol, unknown>;
  for (const v of [1, 2]) g[Symbol.for(`undici.globalDispatcher.${v}`)] = agent;
  return agent;
}
