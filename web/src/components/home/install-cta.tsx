import Link from "next/link";
import { site } from "@/lib/data";
import { InstallDialog } from "./install-dialog";

export function InstallCta() {
  const tools = site.mcpTools.map((t) => t.name);
  const named = ["create_sandbox", "run_command", "run_job"].filter((t) => tools.includes(t));
  return (
    <section className="mt-[var(--section)] bg-ink text-ground">
      <div className="wrap grid min-h-[84svh] grid-cols-1 gap-12 py-16 sm:min-h-[90svh] lg:grid-cols-12 lg:items-center lg:py-20">
        <div className="flex h-full flex-col justify-between gap-6 lg:col-span-5 lg:justify-end lg:pb-6">
          <div>
            <h2 data-reveal className="text-[clamp(3.25rem,13vw,7rem)] leading-[0.92] tracking-[-0.045em] lg:text-[clamp(3.5rem,7vw,7rem)]">
              Give it
              <br />a box
            </h2>
            <p data-reveal className="mt-6 max-w-[42ch] break-words text-[17px] leading-relaxed text-ground/85">
              The MCP server gives your agent {named.join(", ")} and {tools.length - named.length} more tools, on the same ledger as the CLI. Keys
              come from its environment.{" "}
              <Link href="/mcp/" className="text-ground underline decoration-green underline-offset-4">
                Every client
              </Link>
            </p>
          </div>
        </div>
        <div className="flex min-w-0 lg:col-span-6 lg:col-start-7 lg:justify-center">
          <InstallDialog />
        </div>
      </div>
    </section>
  );
}
