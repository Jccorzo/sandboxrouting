/** The sandboxrouting mark: three routes, one taken. Geometry, not illustration. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <path d="M4 12h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 12c3 0 4-6 7-6h4" stroke="currentColor" strokeOpacity=".28" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 12c3 0 4 6 7 6h4" stroke="currentColor" strokeOpacity=".28" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 12h11" stroke="var(--brand)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="20" cy="12" r="2" fill="var(--brand)" />
    </svg>
  );
}
