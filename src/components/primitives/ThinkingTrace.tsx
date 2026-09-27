"use client";

import { useEffect, useState } from "react";

import { DisclosureLabel, DisclosureStatus } from "./DisclosureLabel.js";
import { useTurnDuration } from "./turn-duration.js";

type Props = {
  startedAt?: string;
  completedAt?: string;
  active?: boolean;
  children?: React.ReactNode;
};

/** Collapsible process header. Duration lives here; the final reply stays outside. */
export default function ThinkingTrace({
  startedAt,
  completedAt,
  active = false,
  children,
}: Props) {
  const elapsed = useTurnDuration(startedAt, completedAt, active);
  const [open, setOpen] = useState(active);
  useEffect(() => setOpen(active), [active]);

  const collapsible = !active && Boolean(children);
  const showBody = Boolean(children) && (!collapsible || open);

  return (
    <div className="w-full min-w-0">
      {collapsible ? (
        <DisclosureLabel
          open={open}
          onToggle={() => setOpen((current) => !current)}
          ariaLabel={`用时 ${elapsed}`}
        >
          用时 {elapsed}
        </DisclosureLabel>
      ) : (
        <DisclosureStatus>用时 {elapsed}</DisclosureStatus>
      )}
      {showBody ? <div className="pt-1">{children}</div> : null}
    </div>
  );
}
