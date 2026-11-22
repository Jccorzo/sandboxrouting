import Link from "next/link";
import { CodeBlock } from "@/components/site/code-block";
import { Glyph } from "@/components/site/glyph";
import { lapse, provider, site } from "@/lib/data";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<string, string> = { quota: "free tier marked used up", rate_limit: "rate limited", auth: "key refused" };

function Exchange({ say, children, i }: { say: string; children: React.ReactNode; i: number }) {
  return (
    <div data-reveal style={{ ["--i" as string]: i }} className="space-y-4">
      <p className="text-[20px] font-medium tracking-[-0.01em]">{say}</p>
      {children}
    </div>
  );
}

export function Calls() {
  const route = site.failover[0]!;
  const ids = route.attempts.map((a) => a.provider);
  const job = site.job;
  const end = job.frames.at(-1)!;
  // What happened on each box, read from the job's own frames.
  const boxes = end.placements.map((p, n) => {
    const frames = job.frames.filter((f) => f.box && job.frames.indexOf(f) >= 0 && placementIndex(job.frames, f) === n);
    const ran = [...new Set(frames.filter((f) => f.event === "stepSucceeded").map((f) => f.cursor - 1))];
    const lostAt = frames.find((f) => f.event === "migrate");
    const restored = frames.find((f) => f.event === "prepared");
    return { provider: p.provider, endReason: p.endReason, ran, lostStep: lostAt ? lostAt.cursor : undefined, from: restored?.cursor ?? 0 };
  });

  return (
    <section className="wrap mt-[var(--section)]">
      <div className="mx-auto max-w-[560px] lg:ml-[calc(25%+8px)] lg:mr-0">
        <h2 data-reveal className="text-[28px] tracking-[-0.025em]">
          Three calls
        </h2>
        <div className="mt-14 space-y-[88px]">
          <Exchange i={1} say="First, install it and set the keys you have.">
            <CodeBlock
              lang="bash"
              code={`npm i sandboxrouting modal e2b\nexport MODAL_TOKEN_ID=… MODAL_TOKEN_SECRET=… E2B_API_KEY=…\nnpx sbr providers`}
            />
            <div data-ui className="bg-tone-1 sm:ml-14">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="text-muted">
                    <th className="px-4 pb-1 pt-3 font-medium">provider</th>
                    <th className="px-2 pb-1 pt-3 font-medium">free usage</th>
                    <th className="hidden px-2 pb-1 pt-3 font-medium sm:table-cell">isolation</th>
                    <th className="px-4 pb-1 pt-3 text-right font-medium">checked</th>
                  </tr>
                </thead>
                <tbody>
                  {["modal", "e2b", "docker"].map((id) => {
                    const p = provider(id);
                    return (
                      <tr key={id} className="border-t border-tone-2">
                        <td className="px-4 py-2 font-medium">{id}</td>
                        <td className="px-2 py-2">
                          <span className="mr-1.5 inline-block size-2 rounded-full bg-green align-middle" aria-hidden="true" />
                          {p.freeLabel}
                        </td>
                        <td className="hidden px-2 py-2 sm:table-cell">{p.isolation ?? "not published"}</td>
                        <td className="px-4 py-2 text-right tabular text-muted">{p.checked ?? "your machine"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="px-4 pb-3 pt-2 text-[12.5px] text-muted">and {site.counts.total - 3} more, each skipped until its key is set</p>
            </div>
          </Exchange>

          <Exchange i={2} say="Then ask for a sandbox.">
            <CodeBlock
              lang="ts"
              code={`import { createRouter } from "sandboxrouting";\n\nconst router = await createRouter();\nconst sbx = await router.create({\n  providers: [${ids.map((i) => `"${i}"`).join(", ")}],\n});\nconsole.log(sbx.provider, sbx.route);`}
            />
            <div data-ui className="bg-tone-1 py-2 sm:ml-14" aria-label="What the router tried">
              {route.attempts.map((a) => (
                <div key={a.provider} className="grid grid-cols-[18px_88px_minmax(0,1fr)] items-baseline gap-x-2 px-4 py-1.5 text-[13px]">
                  <span aria-hidden="true" className={cn("font-semibold", a.outcome === "created" ? "text-green-ink" : "text-ink")}>
                    <Glyph kind={a.outcome === "created" ? "ok" : "fail"} />
                  </span>
                  <span className="font-medium">{a.provider}</span>
                  <span className="min-w-0 text-muted">
                    {a.outcome === "created" ? (
                      <span className="text-green-ink">created, billed as {a.billing}</span>
                    ) : (
                      <>
                        {a.detail?.split(":")[0]}: {KIND_LABEL[a.kind ?? ""] ?? a.kind}
                        {a.untilSec ? `, skipped for ${lapse(a.untilSec)}` : ""}
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </Exchange>

          <Exchange i={3} say="Then let the work move when a box dies.">
            <CodeBlock
              lang="ts"
              code={`await router.jobs.run({\n  sandbox: { image: "python:3.12-slim" },\n  setup: [{ run: "${job.spec.setup[0]}" }],\n  steps: [\n${job.spec.steps.map((s, i) => i === job.spec.steps.length - 1 ? `    {\n      run: "${s}",\n      idempotent: false,\n    },` : `    { run: "${s}" },`).join("\n")}\n  ],\n});`}
            />
          </Exchange>
        </div>
      </div>
      <div data-reveal className="mt-4 lg:ml-[calc(25%+8px)] lg:max-w-[760px]">
        <div data-ui className="grid min-w-0 gap-[3px] bg-ground sm:ml-14 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          {boxes.map((b, n) => (
            <div key={b.provider} className={cn("min-w-0 p-4", b.endReason === "finished" ? "bg-green-wash" : "bg-tone-1")}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="font-semibold">
                  Box {n + 1}: {b.provider}
                </span>
                <span className={cn("font-medium", b.endReason === "finished" ? "text-green-ink" : "text-ink")}>{b.endReason}</span>
              </div>
              <ol className="mt-3 space-y-1.5 text-[13px]">
                {n > 0 ? <li className="text-muted">setup again, then checkpoint of step {b.from - 1} restored</li> : <li className="text-muted">setup, initial files</li>}
                {job.spec.steps.map((s, i) => {
                  const done = b.ran.includes(i);
                  const lost = b.lostStep === i;
                  if (!done && !lost) return null;
                  return (
                    <li key={s} className="flex gap-2">
                      <span aria-hidden="true" className={done ? "text-green-ink" : "text-ink"}>
                        <Glyph kind={done ? "ok" : "fail"} />
                      </span>
                      <code className="min-w-0 truncate text-[12.5px]">{s}</code>
                      {lost ? <span className="shrink-0 text-muted">box lost</span> : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[14px] text-muted sm:ml-14">
          The job&rsquo;s states, as the router recorded them: {job.frames.map((f) => f.state).filter((s, i, a) => s !== a[i - 1]).join(" → ")}.{" "}
          <Link href="/how-routing-works/#jobs" className="text-ink underline decoration-green">
            Watch it move
          </Link>
        </p>
      </div>
    </section>
  );
}

/** Which placement a frame belongs to: the count of `placed` events up to it, minus one. */
function placementIndex(frames: (typeof site.job.frames)[number][], f: (typeof site.job.frames)[number]): number {
  const upto = frames.slice(0, frames.indexOf(f) + 1);
  return upto.filter((x) => x.event === "placed").length - 1;
}
