import type { Metadata } from "next";
import { RoutingClient } from "./routing-client";

export const metadata: Metadata = { title: "Routing" };

export default function RoutingPage() {
  return <RoutingClient />;
}
