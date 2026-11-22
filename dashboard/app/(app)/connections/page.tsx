import type { Metadata } from "next";
import { ConnectionsClient } from "./connections-client";

export const metadata: Metadata = { title: "Provider keys" };

export default function ConnectionsPage() {
  return <ConnectionsClient />;
}
