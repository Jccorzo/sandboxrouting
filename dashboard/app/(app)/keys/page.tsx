import { KeysClient } from "./keys-client";

export const dynamic = "force-dynamic";

export default function KeysPage() {
  // Where routers reach back, for the setup snippet (BACK_PUBLIC_URL; BACK_URL is often internal).
  const publicUrl = process.env["BACK_PUBLIC_URL"] ?? process.env["BACK_URL"] ?? "https://your-back.example";
  return <KeysClient publicUrl={publicUrl.replace(/\/+$/, "")} />;
}
