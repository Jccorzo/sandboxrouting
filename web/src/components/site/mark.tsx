/**
 * The mark: one request (the dot) reaching three boxes, the chosen one in green. Drawn on a
 * 24-unit grid so it stays crisp at 16px.
 */
export function Mark({ size = 24, className, inverse = false }: { size?: number; className?: string; inverse?: boolean }) {
  const ink = inverse ? "var(--ground)" : "var(--ink)";
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <circle cx="3.5" cy="12" r="2.5" fill={ink} />
      <path d="M6 12h4M10 12V4.5h4M10 12v7.5h4" stroke={ink} strokeWidth="2" />
      <path d="M10 12h4" stroke="var(--green)" strokeWidth="2" />
      <rect x="15" y="2" width="7" height="5" fill={ink} />
      <rect x="15" y="9.5" width="7" height="5" fill="var(--green)" />
      <rect x="15" y="17" width="7" height="5" fill={ink} />
    </svg>
  );
}
