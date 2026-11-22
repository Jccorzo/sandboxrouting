import Link from "next/link";
import { CAPABILITY_LABEL, ISOLATION_LABEL, date, duration, provider, usd } from "@/lib/data";
import { AdapterPanelClient, type PanelPart } from "./adapter-panel-client";

export function AdapterPanel({ id = "modal" }: { id?: string }) {
  const p = provider(id);
  const perHour = (perSec: number) => usd(perSec * 3600, { perHour: true });
  const parts: PanelPart[] = [
    {
      key: "keys",
      note: { name: "Keys", text: "The variables it needs. Without them the provider is skipped, so a key is all it takes to add one." },
      rows: [
        { label: "id", value: p.id, code: true },
        { label: "env", value: p.env.join(", ") || "none", code: true },
        { label: "sdk", value: p.sdkPackage ?? "REST, no SDK", code: Boolean(p.sdkPackage) },
      ],
    },
    {
      key: "caps",
      note: { name: "Capabilities", text: "What it can do. A request that needs ports or a GPU only goes where they are declared and tested." },
      rows: [{ label: "capabilities", value: p.capabilities.map((c) => CAPABILITY_LABEL[c] ?? c).join(", ") }],
    },
    {
      key: "isolation",
      note: { name: "Isolation", text: "Container, gVisor, microVM or VM. Ask for minIsolation and weaker or unknown providers drop out." },
      rows: [
        { label: "isolation", value: p.isolation ? ISOLATION_LABEL[p.isolation] ?? p.isolation : "not published" },
        { label: "os", value: p.os },
      ],
    },
    {
      key: "limits",
      note: { name: "Limits", text: "The longest a box may live and a command may run. A request over either never reaches it." },
      rows: [
        { label: "max timeout", value: duration(p.maxTimeoutSec) },
        { label: "per command", value: p.maxExecSec ? duration(p.maxExecSec) : "no cap" },
        { label: "enforces TTL", value: p.enforcesTimeout ? "yes" : "no, the router deletes it" },
      ],
    },
    {
      key: "free",
      note: { name: "Free tier", text: "Kind, amount and caps, with the page they came from and the day they were checked. Config can override them." },
      rows: [
        { label: "free usage", value: p.freeLabel },
        { label: "concurrency", value: p.freeTier.concurrency ? String(p.freeTier.concurrency) : "not stated" },
        { label: "lifetime cap", value: duration(p.freeTier.maxLifetimeSec) },
        { label: "checked", value: date(p.checked) },
      ],
    },
    {
      key: "price",
      note: { name: "Price", text: "What a second costs after the free tier. Free credit is metered with it, and strategies rank paid lanes by it." },
      rows: [
        { label: "vCPU", value: perHour(p.pricing.vcpuSecondUsd) },
        { label: "GiB", value: perHour(p.pricing.gibSecondUsd) },
        { label: "2 vCPU, 4 GiB", value: usd(p.maxUsdPerHour, { perHour: true }) },
        { label: "billing", value: p.pricing.billing === "active-cpu" ? "active CPU only" : "wall clock" },
      ],
    },
  ];
  return (
    <section className="wrap mt-[var(--section)]">
      <div className="grid gap-6 lg:grid-cols-[1fr_400px_1fr] lg:gap-12">
        <div className="lg:text-right">
          <h2 data-reveal className="text-[clamp(2rem,3vw,2.5rem)] tracking-[-0.03em]">
            One file per provider
          </h2>
        </div>
        <p data-reveal className="max-w-[52ch] text-[17px] leading-relaxed lg:col-span-2">
          An adapter declares what the router needs to route to it: this is {p.name}&rsquo;s, read from{" "}
          <Link href={`/providers/${p.id}/`} className="underline decoration-green">
            its adapter
          </Link>
          . Only create, exec and kill are code; files, listing and URLs fall back to exec.
        </p>
      </div>
      <AdapterPanelClient title={`${p.name} adapter`} file={p.adapterFile} parts={parts} />
    </section>
  );
}
