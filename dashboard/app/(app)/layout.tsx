import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/server";
import { Shell } from "@/components/shell";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // No session, no dashboard. A key revoked since is caught by the first poll (401 → sign in).
  if (!(await cookies()).get(SESSION_COOKIE)) redirect("/login");
  return <Shell>{children}</Shell>;
}
