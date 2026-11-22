"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FormState = { status: "idle" } | { status: "busy" } | { status: "failed"; message: string };

export function LoginForm() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [state, setState] = useState<FormState>({ status: "idle" });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state.status === "busy") return;
    setState({ status: "busy" });
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-requested-with": "sbr-dashboard" },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        // Stay busy until the dashboard has actually replaced this page.
        router.replace("/");
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
      setState({ status: "failed", message: body?.error?.message ?? `Sign-in failed (${res.status}).` });
    } catch {
      setState({ status: "failed", message: "Can't reach the dashboard server. Check your connection and try again." });
    }
  }

  const busy = state.status === "busy";
  return (
    <form onSubmit={submit} className="mt-6 space-y-3" noValidate>
      <div className="space-y-2">
        <Label htmlFor="token">Admin API key</Label>
        <Input
          id="token"
          name="token"
          type="password"
          autoComplete="current-password"
          spellCheck={false}
          placeholder="sbrk_…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-invalid={state.status === "failed" || undefined}
          aria-describedby={state.status === "failed" ? "token-error" : undefined}
          disabled={busy}
          className="font-mono"
          autoFocus
        />
      </div>
      {state.status === "failed" && (
        <p id="token-error" role="alert" className="text-[13px] text-critical">
          {state.message}
        </p>
      )}
      <Button type="submit" className="w-full" disabled={busy || !token.trim()}>
        {busy && <Loader2 className="animate-spin" />}
        {busy ? "Checking the key…" : "Sign in"}
      </Button>
    </form>
  );
}
