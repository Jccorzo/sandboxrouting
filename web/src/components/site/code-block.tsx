import { codeToHtml } from "shiki";
import { codeTheme } from "@/lib/docs";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

/** Real code, highlighted at build time in the site's palette, with a working copy button. */
export async function CodeBlock({ code, lang = "bash", className, title }: { code: string; lang?: string; className?: string; title?: string }) {
  const html = await codeToHtml(code.trim(), { lang, theme: codeTheme });
  return (
    <div className={cn("min-w-0 bg-tone-1", className)}>
      <div className="flex items-center justify-between gap-3 pl-5 pr-2 pt-2">
        <span className="truncate text-[13px] font-medium text-muted">{title ?? (lang === "ts" ? "TypeScript" : lang === "bash" ? "Shell" : lang.toUpperCase())}</span>
        <CopyButton text={code.trim()} />
      </div>
      <div
        className="overflow-x-auto px-5 pb-4 pt-2 text-[13.5px] leading-[1.65] [&_code]:font-mono [&_pre]:!bg-transparent"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
