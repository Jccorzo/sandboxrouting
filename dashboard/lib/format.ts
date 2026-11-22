// Formatting only. Every value shown was computed by back; nothing here derives a state.

const nf = (max: number, min = 0) => new Intl.NumberFormat("en-US", { maximumFractionDigits: max, minimumFractionDigits: min });

export function num(n: number): string {
  if (n === 0) return "0";
  if (Math.abs(n) < 0.01) return "<0.01";
  if (Math.abs(n) < 10) return nf(2).format(n);
  if (Math.abs(n) < 1000) return nf(1).format(n);
  return nf(0).format(n);
}

export function count(n: number): string {
  return nf(0).format(n);
}

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "$0";
  if (Math.abs(n) < 0.01) return "<$0.01";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n < 100 ? 2 : 0 }).format(n);
}

export function pct(fraction: number): string {
  return `${nf(fraction < 0.1 ? 1 : 0).format(fraction * 100)}%`;
}

export function memory(mib: number): string {
  return mib >= 1024 ? `${nf(1).format(mib / 1024)} GiB` : `${mib} MiB`;
}

export function ms(n: number | undefined): string {
  if (n === undefined) return "—";
  return n < 1000 ? `${Math.round(n)} ms` : `${nf(1).format(n / 1000)} s`;
}

/** "3 min ago" / "in 2 h", measured from the server's `now` so a skewed laptop clock can't lie. */
export function relative(iso: string | number | null | undefined, now: number): string {
  if (iso === null || iso === undefined) return "—";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  const d = t - now;
  const a = Math.abs(d);
  const unit = a < 60_000 ? `${Math.max(1, Math.round(a / 1000))} s` : a < 3_600_000 ? `${Math.round(a / 60_000)} min` : a < 86_400_000 ? `${nf(a < 36_000_000 ? 1 : 0).format(a / 3_600_000)} h` : `${Math.round(a / 86_400_000)} d`;
  if (a < 5_000) return "just now";
  return d < 0 ? `${unit} ago` : `in ${unit}`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(iso)) + " UTC";
}

export function day(isoDay: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${isoDay}T00:00:00Z`));
}

export function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 12)}…` : id;
}
