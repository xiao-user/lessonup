"use client";

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

/** Live thinking / responding phase. Duration belongs on ThinkingTrace. */
export default function LoadingState({
  label = "正在处理请求",
}: {
  label?: string;
}) {
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
    </div>
  );
}
