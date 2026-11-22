import type { Metadata } from "next";
import { Mark } from "@/components/mark";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-panel px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2.5">
          <Mark className="size-6" />
          <span className="text-[15px] font-semibold tracking-[-0.01em]">sandboxrouting</span>
        </div>
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Sign in to your dashboard</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Paste an admin API key. Self-hosting? It&apos;s the <code className="font-mono text-[13px] text-foreground">SBR_ADMIN_TOKEN</code> you gave back, or the key{" "}
          <code className="font-mono text-[13px] text-foreground">account create</code> printed.
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
