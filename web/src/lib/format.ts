// Formatting and labels shared by server pages and client diagrams. Nothing generated is
// imported here, so a client component can use it without shipping the provider list.

export function usd(n: number | undefined, opts: { perHour?: boolean } = {}): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return opts.perHour ? "$0/h" : "$0";
  const digits = n >= 10 ? 2 : n >= 1 ? 2 : n >= 0.1 ? 3 : 4;
  const s = `$${n.toFixed(digits).replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "")}`;
  return opts.perHour ? `${s}/h` : s;
}

export function hours(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 100) return `${Math.round(n).toLocaleString("en-US")} h`;
  if (n >= 10) return `${n.toFixed(0)} h`;
  if (n >= 1) return `${n.toFixed(1).replace(/\.0$/, "")} h`;
  return `${Math.round(n * 60)} min`;
}

export function duration(sec: number | undefined): string {
  if (sec === undefined) return "—";
  if (sec % 86_400 === 0) return `${sec / 86_400} d`;
  if (sec >= 3600) return `${+(sec / 3600).toFixed(1)} h`;
  if (sec >= 60) return `${+(sec / 60).toFixed(1)} min`;
  return `${sec} s`;
}

/** "in 10 min", "in 9.5 d": how long until a reason lapses. */
export function lapse(sec: number | undefined): string {
  if (sec === undefined) return "";
  if (sec >= 86_400) return `${+(sec / 86_400).toFixed(1)} d`;
  if (sec >= 3600) return `${+(sec / 3600).toFixed(1)} h`;
  if (sec >= 60) return `${+(sec / 60).toFixed(1)} min`;
  return `${sec} s`;
}

export function date(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export const ISOLATION_LABEL: Record<string, string> = {
  container: "Container",
  gvisor: "gVisor",
  microvm: "microVM",
  vm: "VM",
};

export const CAPABILITY_LABEL: Record<string, string> = {
  ports: "Public ports",
  pause: "Pause and resume",
  customImage: "Any OCI image",
  gpu: "GPUs",
  snapshot: "Snapshots",
  fileList: "Native file listing",
  extendTimeout: "Extend a live box",
};

export const LANE_LABEL: Record<string, string> = {
  "self-hosted-first": "Your hardware, first",
  "free-recurring": "Free every month",
  "free-one-time": "One-time credit",
  "self-hosted": "Your hardware",
  paid: "Paid",
};

/** The hard filters, in the order docs/routing.md lists and the router applies them. */
export const FILTERS: { n: number; short: string; name: string }[] = [
  { n: 1, short: "Off", name: "Disabled in config, or off by default" },
  { n: 2, short: "Request", name: "Not in the request's providers, or excluded" },
  { n: 3, short: "Own hardware", name: "Self-hosted while selfHosted is never" },
  { n: 4, short: "Keys", name: "Keys missing" },
  { n: 5, short: "Needs", name: "Lacks a capability, or runs another OS" },
  { n: 6, short: "Image", name: "Can't run the image" },
  { n: 7, short: "Timeout", name: "Timeout over the provider's maximum" },
  { n: 8, short: "Exec cap", name: "Longest command over its per-command cap" },
  { n: 9, short: "Isolation", name: "Isolation weaker than minIsolation" },
  { n: 10, short: "Marks", name: "Rate-limit or auth mark in force" },
  { n: 11, short: "Circuit", name: "Circuit open, or its one probe in flight" },
  { n: 12, short: "Billing", name: "Neither free nor paid usage can take it" },
];

export function isFreeLane(lane: string): boolean {
  return lane === "free-recurring" || lane === "free-one-time";
}
