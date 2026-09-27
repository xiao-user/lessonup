"use client";

/** Leading disclosure chevron. Size is 1em so it shares the label's em-square. */
export function DisclosureChevron({
  open,
  overlay = false,
  className,
}: {
  open: boolean;
  overlay?: boolean;
  className?: string;
}) {
  const classes = ["disclosure-chevron", overlay ? "is-overlay" : null, className]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      className={classes}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      data-open={open ? "true" : "false"}
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Collapsible 用时 / ToolChips header. Chevron and text share one em-square. */
export function DisclosureLabel({
  open,
  onToggle,
  children,
  ariaLabel,
}: {
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={ariaLabel}
      onClick={onToggle}
      className="disclosure-label"
    >
      <DisclosureChevron open={open} />
      <span>{children}</span>
    </button>
  );
}

/** Non-collapsible counterpart (live 用时 while the turn is running). */
export function DisclosureStatus({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" className="disclosure-label">
      <span>{children}</span>
    </div>
  );
}
