import { KeysClient } from "./keys-client";

export const dynamic = "force-dynamic";

export default async function KeysPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // A first GitHub sign-in lands here (?welcome=1) to make its first ingest key.
  const welcome = (await searchParams)["welcome"] === "1";
  // Where routers reach back, for the setup snippet (BACK_PUBLIC_URL; BACK_URL is often internal).
  const publicUrl = process.env["BACK_PUBLIC_URL"] ?? process.env["BACK_URL"] ?? "https://your-back.example";
  return <KeysClient publicUrl={publicUrl.replace(/\/+$/, "")} welcome={welcome} />;
}
