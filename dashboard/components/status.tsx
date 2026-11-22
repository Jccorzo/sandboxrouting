// State labels: always an icon and a word, never color alone. The states themselves come from
// back (the router's definitions); this only names and draws them.
import { ArrowRightLeft, Check, CircleDashed, CircleSlash, Clock, Pause, Play, Square, X, Zap, ZapOff, Hourglass, Ban, KeyRound } from "lucide-react";
import type { EffectiveJobState, EffectiveState, FreeStatus, ProviderView } from "@sandboxrouting/back/api";
import { cn } from "@/lib/utils";
import { pct, usd, num, relative } from "@/lib/format";

type Tone = "good" | "live" | "neutral" | "muted" | "warning" | "critical";

const TONE: Record<Tone, string> = {
  good: "text-brand-ink",
  live: "text-brand-ink",
  neutral: "text-foreground",
  muted: "text-muted-foreground",
  warning: "text-warning-ink",
  critical: "text-critical",
};

export function Badge({ tone, icon: Icon, children, title }: { tone: Tone; icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1.5 text-[13px] font-medium", TONE[tone])}>
      <Icon className="size-3.5 shrink-0" strokeWidth={2} />
      {children}
    </span>
  );
}

function LiveDot() {
  return (
    <span className="relative inline-flex size-3.5 items-center justify-center" aria-hidden>
      <span className="absolute size-2 animate-ping rounded-full bg-brand/40 [animation-duration:2s]" />
      <span className="relative size-2 rounded-full bg-brand" />
    </span>
  );
}

const SANDBOX: Record<EffectiveState, { tone: Tone; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  creating: { tone: "neutral", icon: CircleDashed, label: "Creating" },
  running: { tone: "live", icon: LiveDot, label: "Running" },
  paused: { tone: "warning", icon: Pause, label: "Paused" },
  stopped: { tone: "muted", icon: Square, label: "Stopped" },
  expired: { tone: "muted", icon: Clock, label: "Expired" },
  failed: { tone: "critical", icon: X, label: "Failed" },
};

export function SandboxState({ state }: { state: EffectiveState }) {
  const s = SANDBOX[state];
  return (
    <Badge tone={s.tone} icon={s.icon}>
      {s.label}
    </Badge>
  );
}

const JOB: Record<EffectiveJobState, { tone: Tone; icon: React.ComponentType<{ className?: string }>; label: string }> = {
  queued: { tone: "muted", icon: Hourglass, label: "Queued" },
  placing: { tone: "neutral", icon: CircleDashed, label: "Placing" },
  preparing: { tone: "neutral", icon: CircleDashed, label: "Preparing" },
  running: { tone: "live", icon: Play, label: "Running" },
  migrating: { tone: "warning", icon: ArrowRightLeft, label: "Moving" },
  succeeded: { tone: "good", icon: Check, label: "Succeeded" },
  failed: { tone: "critical", icon: X, label: "Failed" },
  cancelled: { tone: "muted", icon: CircleSlash, label: "Cancelled" },
  orphaned: { tone: "warning", icon: ZapOff, label: "Orphaned" },
};

export function JobState({ state }: { state: EffectiveJobState }) {
  const s = JOB[state];
  return (
    <Badge tone={s.tone} icon={s.icon} title={state === "orphaned" ? "Its runner's lease lapsed; a resume or the sweep picks it up." : undefined}>
      {s.label}
    </Badge>
  );
}

export function Circuit({ health, now }: { health: ProviderView["health"]; now: number }) {
  if (health.circuit === "open")
    return (
      <Badge tone="critical" icon={ZapOff} title="Benched after repeated infrastructure failures">
        Open{health.openUntil ? ` · ${relative(health.openUntil, now)}` : ""}
      </Badge>
    );
  if (health.circuit === "half-open")
    return (
      <Badge tone="warning" icon={Zap} title="One create may probe it">
        Half-open
      </Badge>
    );
  return (
    <Badge tone="good" icon={Check}>
      Closed
    </Badge>
  );
}

/** Whether the provider takes requests now: a rate-limit or auth mark keeps it out of every plan. */
export function Availability({ p, now }: { p: ProviderView; now: number }) {
  if (!p.enabled) return <Badge tone="muted" icon={CircleSlash}>Off</Badge>;
  if (!p.availability.ok)
    return (
      <Badge tone={p.availability.kind === "auth" ? "critical" : "warning"} icon={p.availability.kind === "auth" ? KeyRound : Ban}>
        {p.availability.kind === "auth" ? "Key refused" : "Rate limited"} · {relative(p.availability.until, now)}
      </Badge>
    );
  if (!p.configured) return <Badge tone="muted" icon={KeyRound}>No key</Badge>;
  return <Badge tone="good" icon={Check}>Available</Badge>;
}

/** Free usage left as a meter, with the figure in words beside it. */
export function FreeMeter({ free, now }: { free: FreeStatus; now: number }) {
  if (free.state === "unlimited") return <span className="text-[13px] text-muted-foreground">Your hardware · no limit</span>;
  if (free.state === "none") return <span className="text-[13px] text-muted-foreground">No free tier</span>;
  if (free.state === "exhausted")
    return (
      <div className="min-w-[180px]">
        <Meter fraction={0} tone="critical" />
        <div className="mt-1.5 text-[12.5px] text-critical">
          Used up{free.refusedUntil ? ` · rechecked ${relative(free.refusedUntil, now)}` : free.resetsAt ? ` · resets ${relative(free.resetsAt, now)}` : ""}
        </div>
      </div>
    );
  const left = free.unit === "usd" ? `${usd(free.remaining)} left` : `${num(free.remaining)} h left`;
  return (
    <div className="min-w-[180px]">
      <Meter fraction={free.fraction} tone={free.fraction < 0.15 ? "warning" : "good"} />
      <div className="mt-1.5 text-[12.5px] text-muted-foreground">
        <span className="font-medium text-foreground">{left}</span> · {pct(free.fraction)}
        {free.resetsAt ? ` · resets ${relative(free.resetsAt, now)}` : ""}
        {free.basis === "provider" ? " · per provider" : ""}
      </div>
    </div>
  );
}

function Meter({ fraction, tone }: { fraction: number; tone: "good" | "warning" | "critical" }) {
  const f = Math.max(0, Math.min(1, fraction));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)}>
      <div
        className={cn("h-full rounded-full transition-[width] duration-300", tone === "good" ? "bg-brand" : tone === "warning" ? "bg-warning" : "bg-critical")}
        style={{ width: `${f * 100}%` }}
      />
    </div>
  );
}
