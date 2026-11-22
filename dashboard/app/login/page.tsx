import type { Metadata } from "next";
import { Mark } from "@/components/mark";
import { authConfig } from "@/lib/server";
import { loginErrorMessage } from "@/lib/oauth";
import { LoginForm } from "./login-form";
import { GitHubSignIn } from "./github-sign-in";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const error = loginErrorMessage((await searchParams)["error"]);
  // GitHub when back has it set up (the hosted version); an admin key otherwise (self-hosting).
  const cfg = await authConfig();
  const github = Boolean(cfg?.github);
  return (
    <main className="grid min-h-dvh place-items-center bg-panel px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <Mark className="size-6" />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">sandboxrouting</span>
        </div>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Sign in to your dashboard</h1>
        {github ? (
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Your first sign-in makes your account. We only read your public GitHub profile.</p>
        ) : (
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Paste an admin API key. Self-hosting? It&apos;s the <code className="font-mono text-[13px] text-foreground">SBR_ADMIN_TOKEN</code> you gave back, or the key{" "}
            <code className="font-mono text-[13px] text-foreground">account create</code> printed.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-[13px] text-critical">
            {error}
          </p>
        )}
        {!cfg && !error && (
          <p role="alert" className="mt-4 text-[13px] text-critical">
            {loginErrorMessage("back_unreachable")}
          </p>
        )}
        {github ? <GitHubSignIn /> : <LoginForm />}
      </div>
    </main>
  );
}
