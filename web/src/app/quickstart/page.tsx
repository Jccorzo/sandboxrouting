import { readFileSync } from "node:fs";
import path from "node:path";
import Link from "next/link";
import { CodeBlock } from "@/components/site/code-block";
import { JsonLd } from "@/components/site/json-ld";
import { NpmNote } from "@/components/site/npm-note";
import { provider, site } from "@/lib/data";
import { repoRoot } from "@/lib/docs";
import { breadcrumbLd, pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Quickstart",
  description: "Install sandboxrouting, set a provider key, create a sandbox and run a command, see where a request would go, and run a job that survives losing its box.",
  path: "/quickstart/",
  og: "quickstart",
});

function Step({ title, children, code }: { title: string; children: React.ReactNode; code: React.ReactNode }) {
  return (
    <section className="grid gap-6 lg:grid-cols-12 lg:gap-10">
      <div data-reveal className="lg:col-span-5">
        <h2 className="text-[clamp(1.75rem,1.2rem+1.6vw,2.5rem)] tracking-[-0.03em]">{title}</h2>
        <div className="mt-3 max-w-[48ch] space-y-3 text-[17px] leading-relaxed">{children}</div>
      </div>
      <div data-reveal className="min-w-0 space-y-3 lg:col-span-7">
        {code}
      </div>
    </section>
  );
}

export default function Quickstart() {
  // The example config is the repository's own file, read at build time.
  const example = readFileSync(path.join(repoRoot(), "sandboxrouting.example.json"), "utf8");
  const modal = provider("modal");
  const e2b = provider("e2b");
  return (
    <>
      <JsonLd data={breadcrumbLd([{ name: "Home", path: "/" }, { name: "Quickstart", path: "/quickstart/" }])} />
      <header className="wrap pt-14 sm:pt-20 lg:pt-28">
        <h1 data-reveal className="text-[clamp(2.6rem,1.2rem+5.2vw,5rem)] leading-[0.98] tracking-[-0.035em]">
          A sandbox in four lines
        </h1>
        <p data-reveal className="mt-6 max-w-[58ch] text-[19px] leading-relaxed">
          Node 20 or newer. Each provider&rsquo;s SDK is an optional peer dependency, loaded only when that provider is used, so you install the router
          plus the providers you have keys for.
        </p>
        <div data-reveal className="mt-8 max-w-[70ch]">
          <NpmNote />
        </div>
      </header>

      <div className="wrap mt-20 space-y-[clamp(72px,9vw,140px)]">
        <Step title="Install it" code={<CodeBlock lang="bash" code={`npm i sandboxrouting ${modal.sdkPackage} ${e2b.sdkPackage}`} />}>
          <p>
            The router plus two providers&rsquo; SDKs. Providers that speak REST need nothing extra; a provider whose key is set but whose SDK is
            missing is skipped with an install hint.
          </p>
        </Step>

        <Step
          title="Set the keys you have"
          code={<CodeBlock lang="bash" code={[...modal.env, ...e2b.env].map((e) => `export ${e}=…`).join("\n")} />}
        >
          <p>
            Keys come from the environment. {modal.name} gives {modal.freeLabel} and {e2b.name} {e2b.freeLabel}; each provider&rsquo;s page lists
            its keys. Local Docker needs none and goes after the free tiers.
          </p>
          <p>
            <Link href="/providers/" className="underline decoration-green">
              All {site.counts.total} providers and their keys
            </Link>
          </p>
        </Step>

        <Step
          title="Create a sandbox"
          code={
            <CodeBlock
              lang="ts"
              code={`import { createRouter } from "sandboxrouting";\n\nconst router = await createRouter();\nconst sbx = await router.create({ timeoutSec: 600 });\nconst r = await sbx.commands.run("python3 -c 'print(6*7)'");\nawait sbx.files.write("/work/app.py", "print('hi')");\nconsole.log(sbx.provider, r.stdout);\nawait sbx.kill();`}
            />
          }
        >
          <p>
            The router picks a provider with free usage left that can take the whole request, and tries the next one if it refuses.{" "}
            <code className="text-[15px]">sbx.route</code> says what it tried and why.
          </p>
        </Step>

        <Step
          title="See where it would go"
          code={<CodeBlock lang="bash" code={`npx sbr providers          # free-tier status, health and circuit\nnpx sbr route --needs ports # where a sandbox would go, and why\nnpx sbr route --compare     # the same request under every strategy\nnpx sbr run -- python3 -c 'print(42)'`} />}
        >
          <p>
            The CLI is <code className="text-[15px]">sbr</code>. It plans without creating anything, so you can check a config before it spends a
            cent. <code className="text-[15px]">sbr serve</code> starts the REST API and <code className="text-[15px]">sbr mcp</code> the MCP server.
          </p>
        </Step>

        <Step
          title="Run work that can move"
          code={
            <CodeBlock
              lang="ts"
              code={`const job = await router.jobs.run({\n  sandbox: { image: "python:3.12-slim" },\n  files: { "main.py": "print('hi')" },\n  setup: [{ run: "pip install -q requests" }],\n  steps: [\n    { run: "python main.py > out.txt" },\n    { run: "curl -fsS -X POST https://hooks.example/done", idempotent: false },\n  ],\n});\nconsole.log(job.state, job.migrations);`}
            />
          }
        >
          <p>
            A job checkpoints its working directory after each step. If the box dies or its provider refuses, it continues on another box from the
            last checkpoint.{" "}
            <Link href="/how-routing-works/#jobs" className="underline decoration-green">
              Watch one move
            </Link>
          </p>
        </Step>

        <Step title="Configure it" code={<CodeBlock lang="json" title="sandboxrouting.json (the repository's example)" code={example} />}>
          <p>
            Every field is optional. The router reads <code className="text-[15px]">./sandboxrouting.json</code>, else{" "}
            <code className="text-[15px]">~/.sandboxrouting/config.json</code>, or the path in <code className="text-[15px]">SBR_CONFIG</code>.
          </p>
          <p>
            <Link href="/docs/configuration/" className="underline decoration-green">
              Configuration reference
            </Link>
          </p>
        </Step>
      </div>
    </>
  );
}
