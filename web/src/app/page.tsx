import { AdapterPanel } from "@/components/home/adapter-panel";
import { AllowPaidField } from "@/components/home/allow-paid";
import { Calls } from "@/components/home/calls";
import { Faq } from "@/components/home/faq";
import { Hero } from "@/components/home/hero";
import { InstallCta } from "@/components/home/install-cta";
import { Tiers } from "@/components/home/tiers";
import { JsonLd } from "@/components/site/json-ld";
import { site } from "@/lib/data";
import { FAQ } from "@/lib/faq";
import { faqLd, pageMetadata, softwareApplicationLd } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "sandboxrouting: sandboxes from every free tier",
  absoluteTitle: true,
  description: `One router for ${site.counts.total} cloud sandbox providers: E2B, Daytona, Modal, Vercel, Cloudflare and more. Uses every free tier first, fails over when a provider refuses, and moves work when a box dies. SDK, CLI, REST API, MCP server.`,
  path: "/",
  og: "home",
});

export default function Home() {
  return (
    <>
      <JsonLd data={softwareApplicationLd()} />
      <JsonLd data={faqLd(FAQ)} />
      <Hero />
      <Calls />
      <AllowPaidField {...site.hero.ranked} total={site.counts.total} />
      <Tiers />
      <AdapterPanel />
      <Faq />
      <InstallCta />
    </>
  );
}
