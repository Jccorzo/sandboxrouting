// Open Graph images, rendered at build time with next/og. One layout for every page: the title
// large, one line under it, and the mark. Albert Sans is fetched once at build; without network
// the image falls back to next/og's own font rather than failing the build.

import { ImageResponse } from "next/og";

export const OG_SIZE = { width: 1200, height: 630 };

let font: Promise<ArrayBuffer | undefined> | undefined;

function albertSans(): Promise<ArrayBuffer | undefined> {
  font ??= (async () => {
    try {
      // Without a browser user agent, Google Fonts serves TrueType, which next/og can read.
      const css = await (await fetch("https://fonts.googleapis.com/css2?family=Albert+Sans:wght@600")).text();
      const url = /src: url\((https:[^)]+)\) format\('(truetype|opentype)'\)/.exec(css)?.[1];
      if (!url) return undefined;
      return await (await fetch(url)).arrayBuffer();
    } catch {
      return undefined;
    }
  })();
  return font;
}

export async function ogImage({ title, line, accent = false }: { title: string; line: string; accent?: boolean }) {
  const data = await albertSans();
  const ink = "#0b0b0a";
  const green = "#17b057";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: accent ? green : "#ffffff", padding: 72, fontFamily: data ? "Albert Sans" : undefined, color: ink }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, fontSize: 34, letterSpacing: "-0.03em" }}>
          <svg width="44" height="44" viewBox="0 0 24 24">
            <circle cx="3.5" cy="12" r="2.5" fill={ink} />
            <path d="M6 12h4M10 12V4.5h4M10 12v7.5h4" stroke={ink} strokeWidth="2" fill="none" />
            <rect x="15" y="2" width="7" height="5" fill={ink} />
            <rect x="15" y="9.5" width="7" height="5" fill={accent ? "#ffffff" : green} />
            <rect x="15" y="17" width="7" height="5" fill={ink} />
          </svg>
          sandboxrouting
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: title.length > 34 ? 76 : 96, lineHeight: 1, letterSpacing: "-0.04em", maxWidth: 1000 }}>{title}</div>
          <div style={{ fontSize: 32, lineHeight: 1.3, maxWidth: 980 }}>{line}</div>
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts: data ? [{ name: "Albert Sans", data, weight: 600, style: "normal" }] : undefined },
  );
}
