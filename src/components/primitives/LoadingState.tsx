"use client";

import { useEffect, useState } from "react";

const dotDelays = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

function LoaderGrid() {
  return (
    <span aria-hidden className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {dotDelays.map((delay, index) => (
        <span
          key={index}
          className="size-[4px] rounded-full bg-ink"
          style={{ animation: `pixel-on 650ms ease-in-out ${delay}ms infinite`, opacity: 0.15 }}
        />
      ))}
    </span>
  );
}

function useElapsed() {
  const [deciseconds, setDeciseconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setDeciseconds((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, []);

  const total = deciseconds / 10;
  return total < 60 ? `${total.toFixed(1)}s` : `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

/** Native Beautiful UI loading treatment used before Pi emits its first public event. */
export default function LoadingState({ label = "Churning" }: { label?: string }) {
  const elapsed = useElapsed();
  return (
    <div role="status" className="flex w-fit items-center gap-2.5">
      <LoaderGrid />
      <span
        className="bg-clip-text text-[13px] font-medium text-transparent"
        style={{
          backgroundImage: "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
          backgroundSize: "200% 100%",
          animation: "shimmer-text 1.4s linear infinite",
        }}
      >
        {label}
      </span>
      <span className="font-mono text-[12px] text-ink-3 tabular-nums">{elapsed}</span>
    </div>
  );
}
