"use client";

import { useState } from "react";
import { CopyButton } from "@/components/site/copy-button";
import { MCP_CLIENTS } from "@/lib/mcp-clients";
import { cn } from "@/lib/utils";

const VALID = /^[a-z][a-z0-9_-]{0,39}$/;

/** The first step, already open: name the server, pick the client, copy what it needs. */
export function InstallDialog({ clients = ["claude-code", "cursor"] }: { clients?: string[] }) {
  const choices = MCP_CLIENTS.filter((c) => clients.includes(c.id));
  const [client, setClient] = useState(choices[0]!.id);
  const [name, setName] = useState("sandboxes");
  const c = choices.find((x) => x.id === client) ?? choices[0]!;
  const valid = VALID.test(name);
  const snippet = c.snippet(valid ? name : "sandboxes");

  return (
    <div data-ui role="group" aria-labelledby="install-title" className="w-full max-w-[460px] rounded-[10px] bg-ground p-6 text-ink shadow-[0_24px_60px_-20px_rgba(0,0,0,0.55)]">
      <p id="install-title" className="text-[17px] font-semibold tracking-[-0.01em]">
        Add sandboxes to your agent
      </p>
      <label className="mt-5 block text-[13px] font-medium text-muted" htmlFor="server-name">
        Server name
      </label>
      <input
        id="server-name"
        value={name}
        onChange={(e) => setName(e.target.value.trim().toLowerCase())}
        aria-invalid={!valid}
        aria-describedby="server-name-hint"
        spellCheck={false}
        className={cn(
          "mt-1.5 h-11 w-full rounded-[6px] border bg-ground px-3 font-mono text-[14px] outline-none transition-colors focus:border-ink",
          valid ? "border-tone-3" : "border-ink",
        )}
      />
      <p id="server-name-hint" className="mt-1 text-[12.5px] text-muted">
        {valid ? "What your agent will call the tools' server." : "Lowercase letters, digits, - and _, starting with a letter."}
      </p>
      <div role="radiogroup" aria-label="Client" className="mt-5 grid grid-cols-2 gap-1 rounded-[7px] bg-tone-1 p-1">
        {choices.map((x) => (
          <button
            key={x.id}
            type="button"
            role="radio"
            aria-checked={x.id === client}
            onClick={() => setClient(x.id)}
            className={cn("h-9 rounded-[5px] text-[14px] font-medium transition-colors", x.id === client ? "bg-ground text-ink shadow-sm" : "text-muted hover:text-ink")}
          >
            {x.name}
          </button>
        ))}
      </div>
      <p className="mt-4 text-[12.5px] text-muted">{c.where}</p>
      <pre className="mt-1.5 max-h-[150px] overflow-auto rounded-[6px] bg-tone-1 px-3 py-2.5 text-[12.5px] leading-relaxed">
        <code>{snippet}</code>
      </pre>
      <CopyButton
        text={snippet}
        tone="dark"
        label={c.lang === "bash" ? "Copy command" : "Copy config"}
        className="mt-4 h-[52px] w-full rounded-[6px] text-[15px] sm:h-11"
      />
    </div>
  );
}
