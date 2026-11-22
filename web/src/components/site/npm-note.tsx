import { MCP_FROM_CLONE } from "@/lib/mcp-clients";
import { REPO_URL } from "@/lib/links";

/**
 * The package isn't on npm yet. Until its first release, say so where an install command
 * appears, and give the command that works today.
 */
export function NpmNote({ mcp = false }: { mcp?: boolean }) {
  return (
    <p className="bg-tone-1 px-5 py-4 text-[15px] leading-relaxed">
      <span className="font-semibold">Before the first npm release:</span> clone{" "}
      <a href={REPO_URL} className="underline decoration-green">
        the repository
      </a>{" "}
      and run <code className="text-[14px]">npm install && npm run build</code>
      {mcp ? (
        <>
          , then use <code className="text-[14px]">{MCP_FROM_CLONE}</code> wherever a snippet says <code className="text-[14px]">npx -y sandboxrouting mcp</code>.
        </>
      ) : (
        <>
          , then <code className="text-[14px]">npm install /path/to/sandboxrouting</code> in your project. The commands below are what works once it is published.
        </>
      )}
    </p>
  );
}
