"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CAPABILITY_LABEL, ISOLATION_LABEL, usd } from "@/lib/format";
import { CATEGORY_LABEL, CATEGORY_ORDER, type Category } from "@/lib/generated-types";
import { cn } from "@/lib/utils";

export interface ProviderRow {
  id: string;
  name: string;
  category: Category;
  free: string;
  freeHours?: number;
  isolation?: string;
  capabilities: string[];
  expected: number;
  max: number;
  activeCpu: boolean;
  checked?: string;
}

const STRENGTH: Record<string, number> = { container: 0, gvisor: 1, microvm: 2, vm: 2 };
type Sort = "category" | "name" | "price" | "free";

export function ProviderTable({ rows }: { rows: ProviderRow[] }) {
  const [category, setCategory] = useState<Category | "all">("all");
  const [needs, setNeeds] = useState<string[]>([]);
  const [isolation, setIsolation] = useState<string>("");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("category");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = rows.filter(
      (r) =>
        (category === "all" || r.category === category) &&
        needs.every((n) => r.capabilities.includes(n)) &&
        (!isolation || (r.isolation !== undefined && (STRENGTH[r.isolation] ?? -1) >= (STRENGTH[isolation] ?? 0))) &&
        (!q || r.id.includes(q) || r.name.toLowerCase().includes(q)),
    );
    const cmp: Record<Sort, (a: ProviderRow, b: ProviderRow) => number> = {
      category: (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name),
      name: (a, b) => a.name.localeCompare(b.name),
      price: (a, b) => a.expected - b.expected,
      free: (a, b) => (b.freeHours ?? -1) - (a.freeHours ?? -1),
    };
    return out.sort(cmp[sort]);
  }, [rows, category, needs, isolation, query, sort]);

  const chip = (on: boolean) =>
    cn("h-9 px-3 text-[14px] font-medium transition-[background-color,color,transform] active:scale-[0.97]", on ? "bg-ink text-ground" : "bg-tone-1 text-ink hover:bg-tone-2");

  return (
    <div>
      <div className="space-y-3">
        <div role="radiogroup" aria-label="Kind of free usage" className="flex flex-wrap gap-1.5">
          {(["all", ...CATEGORY_ORDER] as const).map((c) => (
            <button key={c} type="button" role="radio" aria-checked={category === c} onClick={() => setCategory(c)} className={chip(category === c)}>
              {c === "all" ? `All ${rows.length}` : `${CATEGORY_LABEL[c]} ${rows.filter((r) => r.category === c).length}`}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {Object.entries(CAPABILITY_LABEL).map(([k, label]) => (
            <button key={k} type="button" aria-pressed={needs.includes(k)} onClick={() => setNeeds((n) => (n.includes(k) ? n.filter((x) => x !== k) : [...n, k]))} className={chip(needs.includes(k))}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-[14px]">
            <span className="font-medium">Isolation at least</span>
            <select value={isolation} onChange={(e) => setIsolation(e.target.value)} className="h-9 bg-tone-1 px-2 text-[14px]">
              <option value="">any</option>
              <option value="gvisor">gVisor</option>
              <option value="microvm">microVM or VM</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-[14px]">
            <span className="font-medium">Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-9 bg-tone-1 px-2 text-[14px]">
              <option value="category">by kind</option>
              <option value="free">most free hours</option>
              <option value="price">cheapest paid</option>
              <option value="name">by name</option>
            </select>
          </label>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or id"
            aria-label="Search providers"
            className="h-9 min-w-[220px] flex-1 bg-tone-1 px-3 text-[14px] outline-none placeholder:text-muted focus:bg-tone-2"
          />
        </div>
      </div>

      <p className="mt-6 text-[14px] text-muted" aria-live="polite">
        {shown.length} of {rows.length} providers
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-[14.5px]">
          <thead>
            <tr className="bg-tone-1 text-[13px]">
              <th className="px-3 py-2.5 font-semibold">Provider</th>
              <th className="px-3 py-2.5 font-semibold">Free usage</th>
              <th className="px-3 py-2.5 font-semibold">Free hours at 2 vCPU, 4 GiB</th>
              <th className="px-3 py-2.5 font-semibold">Paid, ranked at</th>
              <th className="px-3 py-2.5 font-semibold">Isolation</th>
              <th className="px-3 py-2.5 font-semibold">Checked</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-tone-2 transition-colors hover:bg-tone-1">
                <td className="px-3 py-2.5">
                  <Link href={`/providers/${r.id}/`} className="font-medium hover:underline">
                    {r.name}
                  </Link>
                  <code className="ml-2 text-[13px] text-muted">{r.id}</code>
                </td>
                <td className="px-3 py-2.5">
                  {r.category === "monthly" || r.category === "one-time" || r.category === "self-hosted" ? (
                    <span className="mr-1.5 inline-block size-2 rounded-full bg-green align-middle" aria-hidden="true" />
                  ) : null}
                  {r.free}
                </td>
                <td className="px-3 py-2.5 tabular">{r.freeHours !== undefined ? `${r.freeHours >= 100 ? Math.round(r.freeHours) : r.freeHours.toFixed(1)} h` : r.category === "self-hosted" ? "unlimited" : "—"}</td>
                <td className="px-3 py-2.5 tabular">
                  {usd(r.expected, { perHour: true })}
                  {r.activeCpu ? <span className="block text-[13px] text-muted">up to {usd(r.max, { perHour: true })}, active CPU</span> : null}
                </td>
                <td className="px-3 py-2.5">{r.isolation ? ISOLATION_LABEL[r.isolation] ?? r.isolation : <span className="text-muted">not published</span>}</td>
                <td className="px-3 py-2.5 tabular text-muted">{r.checked ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? <p className="py-10 text-[16px]">No provider matches all of these. Drop a filter to widen it.</p> : null}
      </div>
    </div>
  );
}
