"use client";

/* ─────────────────────────────────────────────────────────
 * THINKING — Beautiful UI sparkle + shimmer header.
 *
 * Production uses the library chrome, not the demo's timed
 * fake traces. LessonUp only names the public lifecycle
 * phase (正在思考 / 正在准备) until a real tool event arrives.
 * ───────────────────────────────────────────────────────── */

export default function ThinkingState({
  label = "正在思考",
  working = true,
}: {
  label?: string;
  working?: boolean;
}) {
  return (
    <div role="status" className="-mx-1.5 flex w-fit items-center gap-2 rounded-control px-1.5 py-1">
      <svg width="16" height="16" viewBox="0 0 24 24" fill={working ? "var(--ink-2)" : "var(--ink-3)"} aria-hidden="true">
        <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />
      </svg>
      {working ? (
        <span
          className="bg-clip-text text-[13px] font-medium whitespace-nowrap text-transparent"
          style={{
            backgroundImage: "linear-gradient(90deg, var(--ink-3) 35%, var(--ink) 50%, var(--ink-3) 65%)",
            backgroundSize: "200% 100%",
            animation: "shimmer-text 1.4s linear infinite",
          }}
        >
          {label}
        </span>
      ) : (
        <span className="text-[13px] font-medium whitespace-nowrap text-ink-2">{label}</span>
      )}
    </div>
  );
}
