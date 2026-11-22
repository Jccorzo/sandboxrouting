"use client";

import { useState } from "react";
import { Check, Copy, KeyRound, Loader2, TriangleAlert } from "lucide-react";
import type { CreatedKey, KeyView, KeysView, Me } from "@sandboxrouting/back/api";
import { api } from "@/lib/api";
import { usePoll } from "@/lib/use-poll";
import { EmptyState, Freshness, Loaded, PageHeader, Section, TableSkeleton } from "@/components/view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { relative } from "@/lib/format";
import { cn } from "@/lib/utils";

/** One row's revoke: ask, send, then whatever back said. Cleared on every outcome by the next action. */
type RowAction = { state: "confirming" } | { state: "busy" } | { state: "failed"; message: string } | { state: "done"; message: string };

type CreateState = { state: "idle" } | { state: "busy" } | { state: "failed"; message: string } | { state: "created"; created: CreatedKey };

export function KeysClient({ publicUrl }: { publicUrl: string }) {
  const keys = usePoll<KeysView>("keys", 30_000);
  const me = usePoll<Me>("me", 120_000);
  const [rows, setRows] = useState<Record<string, RowAction>>({});
  const setRow = (id: string, a: RowAction | undefined) =>
    setRows((r) => {
      const next = { ...r };
      if (a) next[id] = a;
      else delete next[id];
      return next;
    });

  async function revoke(k: KeyView) {
    setRow(k.id, { state: "busy" });
    const out = await api<{ key: KeyView }>(`keys/${k.id}/revoke`, { method: "POST", body: {} });
    if (out.ok) {
      setRow(k.id, { state: "done", message: "Revoked. Anything using it is refused from now on." });
    } else if (out.failure.kind === "http" && out.failure.status === 409) {
      // Someone else changed it, or it's the last admin key: show what back says it is now.
      setRow(k.id, { state: "failed", message: out.failure.message });
    } else {
      setRow(k.id, { state: "failed", message: `${out.failure.message} Nothing changed.` });
    }
    keys.refresh();
  }

  const mine = me.status === "ready" ? me.data.key.id : undefined;

  return (
    <>
      <PageHeader title="API keys" description="Ingest keys let a router send its events here. Admin keys sign in to this dashboard and manage keys. back stores only a hash: a key is shown once, when you make it.">
        <Freshness view={keys} onRetry={keys.refresh} />
      </PageHeader>

      <CreateKey publicUrl={publicUrl} onCreated={keys.refresh} />

      <Section title="Keys" className="mt-12">
        <Loaded view={keys} skeleton={<TableSkeleton rows={3} cols={5} />}>
          {(d) => {
            const now = Date.parse(d.now);
            if (!d.keys.length) return <EmptyState title="No keys">Make one above.</EmptyState>;
            return (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Made</TableHead>
                    <TableHead>Last used</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {d.keys.map((k) => {
                    const a = rows[k.id];
                    return (
                      <TableRow key={k.id} className={cn(k.state === "revoked" && "text-muted-foreground")}>
                        <TableCell className="font-medium">
                          {k.name}
                          {k.id === mine && <span className="ml-2 rounded bg-brand-wash px-1.5 py-0.5 text-[11px] font-medium text-brand-ink">this session</span>}
                        </TableCell>
                        <TableCell className="font-mono text-[12.5px]">{k.prefix}…</TableCell>
                        <TableCell>{k.scope === "admin" ? "Admin" : "Ingest"}</TableCell>
                        <TableCell title={k.createdAt}>{relative(k.createdAt, now)}</TableCell>
                        <TableCell>{k.lastUsedAt ? relative(k.lastUsedAt, now) : "never"}</TableCell>
                        <TableCell className="text-right">
                          {k.state === "revoked" ? (
                            <span className="text-[13px]">Revoked {relative(k.revokedAt, now)}</span>
                          ) : a?.state === "confirming" ? (
                            <span className="inline-flex items-center gap-2">
                              <span className="text-[12.5px] text-muted-foreground">{k.id === mine ? "Revoke the key you're signed in with?" : "Revoke for good?"}</span>
                              <Button size="xs" variant="destructive" onClick={() => revoke(k)}>
                                Revoke
                              </Button>
                              <Button size="xs" variant="ghost" onClick={() => setRow(k.id, undefined)}>
                                Keep
                              </Button>
                            </span>
                          ) : a?.state === "busy" ? (
                            <Button size="xs" variant="outline" disabled>
                              <Loader2 className="animate-spin" /> Revoking…
                            </Button>
                          ) : (
                            <Button size="xs" variant="outline" onClick={() => setRow(k.id, { state: "confirming" })}>
                              Revoke
                            </Button>
                          )}
                          {(a?.state === "failed" || a?.state === "done") && (
                            <div role="status" className={cn("mt-1 text-[12px]", a.state === "failed" ? "text-critical" : "text-brand-ink")}>
                              {a.message}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            );
          }}
        </Loaded>
      </Section>
    </>
  );
}

function CreateKey({ publicUrl, onCreated }: { publicUrl: string; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"ingest" | "admin">("ingest");
  const [state, setState] = useState<CreateState>({ state: "idle" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state.state === "busy") return;
    setState({ state: "busy" });
    const out = await api<CreatedKey>("keys", { method: "POST", body: { name: name.trim(), scope } });
    if (out.ok) {
      setState({ state: "created", created: out.data });
      setName("");
      onCreated();
    } else {
      setState({ state: "failed", message: `${out.failure.message} No key was made.` });
    }
  }

  return (
    <section aria-labelledby="new-key" className="rounded-xl border bg-panel p-5">
      <h2 id="new-key" className="text-[15px] font-semibold tracking-[-0.01em]">
        Make a key
      </h2>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-2">
          <Label htmlFor="key-name">Name</Label>
          <Input id="key-name" placeholder="e.g. ci-runner, laptop" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} disabled={state.state === "busy"} className="bg-background" />
        </div>
        <div className="space-y-2">
          <span className="text-[13px] font-medium leading-none">Scope</span>
          <Segmented
            label="Scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: "ingest", label: "Ingest" },
              { value: "admin", label: "Admin" },
            ]}
            className="flex h-9"
          />
        </div>
        <Button type="submit" disabled={state.state === "busy" || !name.trim()}>
          {state.state === "busy" && <Loader2 className="animate-spin" />}
          {state.state === "busy" ? "Making…" : "Make key"}
        </Button>
      </form>
      {state.state === "failed" && (
        <p role="alert" className="mt-3 text-[13px] text-critical">
          {state.message}
        </p>
      )}
      {state.state === "created" && <NewToken created={state.created} publicUrl={publicUrl} onDismiss={() => setState({ state: "idle" })} />}
    </section>
  );
}

function NewToken({ created, publicUrl, onDismiss }: { created: CreatedKey; publicUrl: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState<"token" | "env" | null>(null);
  const env = `SBR_REPORT_URL=${publicUrl}\nSBR_REPORT_TOKEN=${created.token}`;
  const copy = async (what: "token" | "env", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };
  return (
    <div className="mt-5 rounded-lg border border-brand/30 bg-background p-4">
      <div className="flex items-start gap-2.5">
        <KeyRound className="mt-0.5 size-4 text-brand-ink" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-medium">
            {created.key.name}: {created.key.scope === "admin" ? "admin" : "ingest"} key made
          </p>
          <p className="mt-0.5 inline-flex items-center gap-1.5 text-[12.5px] text-warning-ink">
            <TriangleAlert className="size-3.5" /> Copy it now. back keeps only its hash; it won&apos;t be shown again.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-panel px-3 py-2 font-mono text-[12.5px]">{created.token}</code>
            <Button size="sm" variant="outline" onClick={() => copy("token", created.token)}>
              {copied === "token" ? <Check /> : <Copy />} {copied === "token" ? "Copied" : "Copy"}
            </Button>
          </div>
          {created.key.scope === "ingest" && (
            <>
              <p className="mt-4 text-[12.5px] text-muted-foreground">Turn on reporting where the router runs:</p>
              <div className="mt-1.5 flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed">{env}</pre>
                <Button size="sm" variant="outline" onClick={() => copy("env", env)}>
                  {copied === "env" ? <Check /> : <Copy />} {copied === "env" ? "Copied" : "Copy"}
                </Button>
              </div>
            </>
          )}
          <Button size="xs" variant="ghost" className="mt-3 -ml-2.5" onClick={onDismiss}>
            I&apos;ve saved it
          </Button>
        </div>
      </div>
    </div>
  );
}
