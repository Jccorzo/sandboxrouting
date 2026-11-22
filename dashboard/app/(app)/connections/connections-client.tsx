"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import type { ApiError, ConnectionResult, ConnectionView, CredentialsView } from "@sandboxrouting/back/api";
import { api, type Outcome } from "@/lib/api";
import { usePoll } from "@/lib/use-poll";
import { Freshness, Loaded, PageHeader, TableSkeleton } from "@/components/view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { relative } from "@/lib/format";
import { cn } from "@/lib/utils";

type Entry = CredentialsView["providers"][number];

/**
 * One provider's edit, from opening the form to back's answer. `seen` is the version the form was
 * opened on: the save is a compare-and-set on it, so a change made elsewhere meanwhile is a 409,
 * never silently overwritten.
 */
type Edit =
  | { state: "editing"; seen: number; values: Record<string, string> }
  | { state: "saving"; seen: number; values: Record<string, string> }
  | { state: "confirm-remove"; seen: number }
  | { state: "removing"; seen: number }
  | { state: "done"; message: string }
  | { state: "failed"; message: string; values?: Record<string, string>; seen?: number };

export function ConnectionsClient() {
  const view = usePoll<CredentialsView>("credentials", 60_000);
  const [edits, setEdits] = useState<Record<string, Edit | undefined>>({});
  const setEdit = (id: string, e: Edit | undefined) => setEdits((all) => ({ ...all, [id]: e }));

  /** What a failed write says, in words: on 409, how the row stands now (the list refreshes too). */
  function failureText(out: Extract<Outcome<unknown>, { ok: false }>, verb: string): string {
    const f = out.failure;
    if (f.kind === "http" && f.status === 409) {
      const now = (f.body as ApiError["error"] | undefined)?.connection;
      const how = now?.state === "active" ? "they're saved, changed since you opened this" : now?.state === "removed" ? "they were removed meanwhile" : "they changed meanwhile";
      return `Not ${verb}: ${how}. The list shows how they stand now.`;
    }
    return `Not ${verb}. ${f.message}`;
  }

  async function save(entry: Entry, seen: number, values: Record<string, string>) {
    setEdit(entry.id, { state: "saving", seen, values });
    const out = await api<ConnectionResult>(`credentials/${entry.id}`, { method: "PUT", body: { values, expectedVersion: seen } });
    if (out.ok) setEdit(entry.id, { state: "done", message: "Saved." });
    else if (out.failure.kind === "http" && out.failure.status === 400) setEdit(entry.id, { state: "failed", message: out.failure.message, values, seen });
    else setEdit(entry.id, { state: "failed", message: failureText(out, "saved") });
    view.refresh();
  }

  async function remove(entry: Entry, seen: number) {
    setEdit(entry.id, { state: "removing", seen });
    const out = await api<ConnectionResult>(`credentials/${entry.id}?expectedVersion=${seen}`, { method: "DELETE" });
    setEdit(entry.id, out.ok ? { state: "done", message: "Removed. The hosted router no longer has these keys." } : { state: "failed", message: failureText(out, "removed") });
    view.refresh();
  }

  return (
    <>
      <PageHeader
        title="Provider keys"
        description="Your own API keys for the providers the hosted router runs. They're encrypted when saved and never shown again: only their last 4 characters. The hosted router uses them to make sandboxes on your accounts."
      >
        <Freshness view={view} onRetry={view.refresh} />
      </PageHeader>

      <Loaded view={view} skeleton={<TableSkeleton rows={6} cols={3} />}>
        {(d) => {
          const now = Date.parse(d.now);
          return (
            <>
              {!d.enabled && (
                <p role="status" className="mb-6 rounded-lg border border-warning/40 bg-warning-wash px-4 py-3 text-sm text-warning-ink">
                  Saving provider keys isn&apos;t set up on this server. Set <code className="font-mono text-[12.5px]">SBR_SECRETS_KEY</code> (or <code className="font-mono text-[12.5px]">SBR_KMS_KEY</code>) on back.
                </p>
              )}
              <ul className="divide-y rounded-xl border bg-panel">
                {d.providers.map((p) => (
                  <ProviderRow
                    key={p.id}
                    entry={p}
                    now={now}
                    enabled={d.enabled}
                    edit={edits[p.id]}
                    onEdit={(e) => setEdit(p.id, e)}
                    onSave={(seen, values) => save(p, seen, values)}
                    onRemove={(seen) => remove(p, seen)}
                  />
                ))}
              </ul>
            </>
          );
        }}
      </Loaded>
    </>
  );
}

function Status({ c, now }: { c: ConnectionView; now: number }) {
  if (c.state !== "active") return <span className="text-[13px] text-muted-foreground">Not connected</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
      <span className="rounded bg-brand-wash px-1.5 py-0.5 text-[11.5px] font-medium text-brand-ink">Connected</span>
      {Object.entries(c.hints).map(([k, v]) => (
        <code key={k} className="font-mono text-[12px] text-muted-foreground" title={k}>
          {v}
        </code>
      ))}
      <span className="text-muted-foreground" title={c.updatedAt}>
        saved {relative(c.updatedAt, now)}
      </span>
    </span>
  );
}

function ProviderRow({
  entry,
  now,
  enabled,
  edit,
  onEdit,
  onSave,
  onRemove,
}: {
  entry: Entry;
  now: number;
  enabled: boolean;
  edit: Edit | undefined;
  onEdit: (e: Edit | undefined) => void;
  onSave: (seen: number, values: Record<string, string>) => void;
  onRemove: (seen: number) => void;
}) {
  const c = entry.connection;
  const connected = c.state === "active";
  // The form stays open while editing, saving, and after a save back refused as invalid (400).
  const form = edit && (edit.state === "editing" || edit.state === "saving" || (edit.state === "failed" && edit.values)) ? edit : undefined;
  const formOpen = form !== undefined;
  const values = form?.values ?? {};
  const seen = form?.seen ?? c.version;
  const busy = edit?.state === "saving" || edit?.state === "removing";
  const filled = entry.fields.every((f) => !f.required || (values[f.name] ?? "").trim());

  return (
    <li className="px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{entry.name}</span>
            <a href={entry.homepage} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" aria-label={`${entry.name} website`}>
              <ExternalLink className="size-3.5" />
            </a>
          </div>
          <div className="mt-1">
            <Status c={c} now={now} />
          </div>
        </div>
        {!formOpen && (
          <div className="flex items-center gap-2">
            {edit?.state === "confirm-remove" || edit?.state === "removing" ? (
              <>
                <span className="text-[12.5px] text-muted-foreground">Remove these keys?</span>
                <Button size="xs" variant="destructive" disabled={busy} onClick={() => onRemove(edit.seen)}>
                  {edit.state === "removing" && <Loader2 className="animate-spin" />}
                  {edit.state === "removing" ? "Removing…" : "Remove"}
                </Button>
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => onEdit(undefined)}>
                  Keep
                </Button>
              </>
            ) : (
              <>
                {connected && (
                  <Button size="xs" variant="ghost" onClick={() => onEdit({ state: "confirm-remove", seen: c.version })}>
                    Remove
                  </Button>
                )}
                <Button size="xs" variant="outline" disabled={!enabled} onClick={() => onEdit({ state: "editing", seen: c.version, values: {} })}>
                  {connected ? "Replace" : "Connect"}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {formOpen && (
        <form
          className="mt-4 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && filled) onSave(seen, values);
          }}
        >
          {entry.fields.map((f) => (
            <div key={f.name} className="space-y-1.5">
              <Label htmlFor={`${entry.id}-${f.name}`}>
                {f.label} <span className="font-mono text-[11.5px] font-normal text-muted-foreground">{f.name}</span>
                {!f.required && <span className="ml-1 text-[12px] font-normal text-muted-foreground">(optional)</span>}
              </Label>
              <Input
                id={`${entry.id}-${f.name}`}
                type={f.kind === "secret" ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                className="bg-background font-mono"
                value={values[f.name] ?? ""}
                disabled={busy}
                onChange={(e) => onEdit({ state: "editing", seen, values: { ...values, [f.name]: e.target.value } })}
              />
              {f.help && <p className="text-[12px] text-muted-foreground">{f.help}</p>}
            </div>
          ))}
          {connected && <p className="text-[12px] text-muted-foreground">Saving replaces the keys saved now.</p>}
          {edit?.state === "failed" && (
            <p role="alert" className="text-[13px] text-critical">
              {edit.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !filled}>
              {busy && <Loader2 className="animate-spin" />}
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onEdit(undefined)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {!formOpen && (edit?.state === "done" || edit?.state === "failed") && (
        <p role="status" className={cn("mt-2 text-[12.5px]", edit.state === "failed" ? "text-critical" : "text-brand-ink")}>
          {edit.message}
        </p>
      )}
    </li>
  );
}
