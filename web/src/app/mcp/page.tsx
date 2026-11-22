import { InstallDialog } from "@/components/home/install-dialog";
import { CodeBlock } from "@/components/site/code-block";
import { JsonLd } from "@/components/site/json-ld";
import { NpmNote } from "@/components/site/npm-note";
import { site } from "@/lib/data";
import { MCP_CLIENTS, MCP_ONE_LINE } from "@/lib/mcp-clients";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "MCP server: sandboxes for Claude Code, Cursor and other agents",
  description: `Give any MCP client cloud sandboxes from ${site.counts.total} providers, free tiers first: ${MCP_ONE_LINE}. Snippets for Claude Code, Cursor, Claude Desktop, VS Code, Windsurf, Codex CLI and Gemini CLI, and the ${site.mcpTools.length} tools it serves.`,
  path: "/mcp/",
  og: "mcp",
});

export default function McpPage() {
  return (
    <>
      <JsonLd data={breadcrumbLd([{ name: "Home", path: "/" }, { name: "MCP server", path: "/mcp/" }])} />
      <header className="wrap grid grid-cols-1 gap-12 pt-14 sm:pt-20 lg:grid-cols-12 lg:pt-28">
        <div className="lg:col-span-7">
          <h1 data-reveal className="max-w-[13ch] text-[clamp(2.6rem,1.2rem+5.2vw,5rem)] leading-[0.98] tracking-[-0.035em]">
            Sandboxes for your agent
          </h1>
          <p data-reveal className="mt-6 max-w-[54ch] text-[19px] leading-relaxed">
            <code className="text-[17px]">{MCP_ONE_LINE}</code> starts an MCP server over stdio. Your agent gets {site.mcpTools.length} tools to create
            sandboxes, run commands, move files and run jobs that survive a box dying, routed free tiers first across {site.counts.total} providers.
            It shares one ledger with the CLI and the REST server, so they agree on what is live and what is spent.
          </p>
          <div data-reveal className="mt-8 max-w-[62ch]">
            <NpmNote mcp />
          </div>
        </div>
        <div className="flex items-start bg-ink p-4 sm:p-10 lg:col-span-5">
          <InstallDialog clients={MCP_CLIENTS.map((c) => c.id).slice(0, 2)} />
        </div>
      </header>

      <section className="wrap mt-[var(--section)]">
        <h2 className="text-[clamp(2rem,1.3rem+2.4vw,3rem)] tracking-[-0.035em]">Every client</h2>
        <p className="mt-4 max-w-[62ch] text-[17px] leading-relaxed">
          The router reads provider keys from the environment it starts in, so put them in the client&rsquo;s <code className="text-[15px]">env</code>{" "}
          block, or export them before starting a terminal client. A provider without its key is skipped.
        </p>
        <div className="mt-10 space-y-12">
          {MCP_CLIENTS.map((c) => (
            <div key={c.id} id={c.id} className="grid scroll-mt-8 gap-4 lg:grid-cols-12 lg:gap-10">
              <div className="lg:col-span-4">
                <h3 className="text-[24px] tracking-[-0.02em]">{c.name}</h3>
                <p className="mt-1 text-[15px] text-muted">{c.where}</p>
              </div>
              <CodeBlock code={c.snippet("sandboxes")} lang={c.lang} className="lg:col-span-8" />
            </div>
          ))}
        </div>
      </section>

      <section className="wrap mt-[var(--section)]">
        <h2 className="text-[clamp(2rem,1.3rem+2.4vw,3rem)] tracking-[-0.035em]">The tools it serves</h2>
        <p className="mt-4 max-w-[62ch] text-[17px] leading-relaxed">Read from the server itself when this site was built.</p>
        <dl className="mt-8 grid gap-x-10 md:grid-cols-2">
          {site.mcpTools.map((t) => (
            <div key={t.name} className="grid gap-1 py-4">
              <dt>
                <code className="text-[15px] font-medium">{t.name}</code>
              </dt>
              <dd className="text-[16px] leading-relaxed">{t.description}</dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
