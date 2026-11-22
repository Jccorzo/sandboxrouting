"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { ApiError, CredentialsView, RouterConfigView } from "@sandboxrouting/back/api";
import { api } from "@/lib/api";
import { configFromForm, formFromConfig, type RoutingForm } from "@/lib/routing-form";
import { ErrorState, PageHeader, Section, TableSkeleton } from "@/components/view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Failure } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The page's lifecycle. The form is loaded once and then belongs to the person: background
 * refreshes would overwrite what they're typing. `base` is what was loaded; saving is a
 * compare-and-set on its version, and a 409 replaces it (and the form) with how it stands now.
 */
type Page =
  | { state: "loading" }
  | { state: "failed"; failure: Failure }
  | { state: "ready"; base: RouterConfigView; providers: { id: string; name: string; connected: boolean }[]; form: RoutingForm; save: Save };

type Save = { state: "idle" } | { state: "saving" } | { state: "saved" } | { state: "failed"; message: string };

const DEFAULT_STRATEGY = "free-first";

export function RoutingClient() {
  const [page, setPage] = useState<Page>({ state: "loading" });
  const gen = useRef(0);

  async function load() {
    const mine = ++gen.current;
    setPage({ state: "loading" });
    const [cfg, creds] = await Promise.all([api<RouterConfigView>("config"), api<CredentialsView>("credentials")]);
    if (mine !== gen.current) return; // an older load answering late
    if (!cfg.ok) return setPage({ state: "failed", failure: cfg.failure });
    if (!creds.ok) return setPage({ state: "failed", failure: creds.failure });
    const providers = creds.data.providers.map((p) => ({ id: p.id, name: p.name, connected: p.connection.state === "active" }));
    setPage({ state: "ready", base: cfg.data, providers, form: formFromConfig(cfg.data.config, providers.map((p) => p.id), DEFAULT_STRATEGY), save: { state: "idle" } });
  }

  useEffect(() => {
    // Loads once on mount; load() guards against an older answer arriving late.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, []);

  if (page.state === "loading")
    return (
      <>
        <Header />
        <TableSkeleton rows={6} cols={3} />
      </>
    );
  if (page.state === "failed")
    return (
      <>
        <Header />
        <ErrorState failure={page.failure} retrying={false} onRetry={() => void load()} />
      </>
    );

  const { base, providers, form, save } = page;
  const set = (f: Partial<RoutingForm>) => setPage({ ...page, form: { ...form, ...f }, save: save.state === "saving" ? save : { state: "idle" } });
  const setProvider = (id: string, f: Partial<RoutingForm["providers"][string]>) => set({ providers: { ...form.providers, [id]: { ...form.providers[id]!, ...f } } });
  const busy = save.state === "saving";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (page.state !== "ready" || busy) return;
    const built = configFromForm(base.config, form);
    if (!built.ok) return setPage({ ...page, save: { state: "failed", message: built.message } });
    setPage({ ...page, save: { state: "saving" } });
    const out = await api<RouterConfigView>("config", { method: "PUT", body: { config: built.config, expectedVersion: base.version } });
    if (out.ok) {
      setPage({ ...page, base: out.data, form: formFromConfig(out.data.config, providers.map((p) => p.id), DEFAULT_STRATEGY), save: { state: "saved" } });
    } else if (out.failure.kind === "http" && out.failure.status === 409) {
      const now = (out.failure.body as ApiError["error"] | undefined)?.config;
      if (now) {
        setPage({
          ...page,
          base: now,
          form: formFromConfig(now.config, providers.map((p) => p.id), DEFAULT_STRATEGY),
          save: { state: "failed", message: "Not saved: the config changed since you loaded it (another tab, or someone else). The form now shows how it stands; make your change again." },
        });
      } else void load();
    } else {
      setPage({ ...page, save: { state: "failed", message: `Not saved. ${out.failure.message}` } });
    }
  }

  return (
    <>
      <Header />
      <form onSubmit={submit} className="space-y-10">
        <Section title="Strategy" description="How the hosted router orders the providers you've connected.">
          <div className="grid gap-2">
            {base.strategies.map((s) => (
              <label key={s.name} className={cn("flex cursor-pointer gap-3 rounded-lg border bg-panel px-4 py-3", form.strategy === s.name && "border-foreground/40")}>
                <input type="radio" name="strategy" value={s.name} checked={form.strategy === s.name} onChange={() => set({ strategy: s.name })} disabled={busy} className="mt-1" />
                <span>
                  <span className="font-mono text-[13px] font-medium">{s.name}</span>
                  <span className="mt-0.5 block text-[13px] text-muted-foreground">{s.description}</span>
                </span>
              </label>
            ))}
          </div>
        </Section>

        <Section title="Paid usage" description="Off: the router only uses free usage, and refuses once it runs out. On: it goes on to paid usage, up to the cap.">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.allowPaid} onChange={(e) => set({ allowPaid: e.target.checked })} disabled={busy} />
              Allow paid usage
            </label>
            <div className="space-y-1.5">
              <Label htmlFor="cap">Monthly cap (USD, optional)</Label>
              <Input id="cap" inputMode="decimal" className="w-40 bg-background" value={form.maxPaidUsdPerMonth} onChange={(e) => set({ maxPaidUsdPerMonth: e.target.value })} disabled={busy || !form.allowPaid} placeholder="no cap" />
            </div>
          </div>
        </Section>

        <Section title="Providers" description="Turn a provider off, or set its priority (lower goes first among providers in the same lane; default 100). Only providers with saved keys are used.">
          <ul className="divide-y rounded-xl border bg-panel">
            {providers.map((p) => {
              const f = form.providers[p.id]!;
              return (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <span className="text-sm">
                    <span className="font-medium">{p.name}</span>
                    {!p.connected && <span className="ml-2 text-[12px] text-muted-foreground">no keys saved</span>}
                  </span>
                  <span className="flex items-center gap-4">
                    <Input aria-label={`${p.name} priority`} inputMode="numeric" className="h-8 w-24 bg-background" placeholder="100" value={f.priority} onChange={(e) => setProvider(p.id, { priority: e.target.value })} disabled={busy} />
                    <label className="flex items-center gap-2 text-[13px]">
                      <input type="checkbox" checked={f.enabled} onChange={(e) => setProvider(p.id, { enabled: e.target.checked })} disabled={busy} />
                      On
                    </label>
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {busy ? "Saving…" : "Save"}
          </Button>
          {save.state === "saved" && (
            <span role="status" className="text-[13px] text-brand-ink">
              Saved (version {base.version}).
            </span>
          )}
          {save.state === "failed" && (
            <span role="alert" className="text-[13px] text-critical">
              {save.message}
            </span>
          )}
        </div>
      </form>
    </>
  );
}

function Header() {
  return <PageHeader title="Routing" description="How the hosted router picks a provider for each sandbox: its strategy, whether it may use paid usage, and per-provider switches. It runs with only the providers you've saved keys for." />;
}
