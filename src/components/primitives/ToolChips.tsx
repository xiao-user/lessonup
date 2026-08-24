"use client";

import { useEffect, useState } from "react";

/* ─────────────────────────────────────────────────────────
 * TOOL CHIPS
 * The Beautiful UI primitive, driven by normalized public Pi
 * events instead of the repository's timed demo rows.
 * ───────────────────────────────────────────────────────── */

export type ToolActivity = {
  id: string;
  name?: string;
  label: string;
  detail?: string;
  state: "running" | "completed" | "unchanged" | "needs_revision" | "failed" | "cancelled";
  turn?: number;
  progress?: { label?: string; current?: number; total?: number } | null;
};

export type TurnState = "running" | "completed" | "failed" | "cancelled";

const Icons: Record<string, React.ReactNode> = {
  think: <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" />,
  write: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></g>,
  run: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 17l6-5-6-5M12 19h8" /></g>,
  read: <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></g>,
};

const STATE_LABEL: Record<ToolActivity["state"], string> = {
  running: "运行中",
  completed: "完成",
  unchanged: "无需变更",
  needs_revision: "需要调整",
  failed: "失败",
  cancelled: "已停止",
};

function iconFor(name = "") {
  if (/read|search|lookup|fetch|inspect|browser/i.test(name)) return "read";
  if (/write|edit|patch|propose|create|update/i.test(name)) return "write";
  if (/run|exec|test|build|command/i.test(name)) return "run";
  return "think";
}

function timestamp(value?: string | null) {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function turnDurationMs(startedAt?: string | null, completedAt?: string | null, now = Date.now()) {
  const started = timestamp(startedAt);
  if (started === null) return 0;
  return Math.max(0, (timestamp(completedAt) ?? now) - started);
}

export function formatTurnDuration(milliseconds: number) {
  const seconds = Math.max(0, milliseconds) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  if (minutes < 60) return `${minutes}分${remainingSeconds}秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours}小时${minutes % 60}分`;
}

function useTurnDuration(startedAt: string | undefined, completedAt: string | undefined, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  return formatTurnDuration(turnDurationMs(startedAt, completedAt, now));
}

function headerLabel(state: TurnState, elapsed: string) {
  if (state === "running") return `已处理 ${elapsed}`;
  if (state === "failed") return `失败 · ${elapsed}`;
  if (state === "cancelled") return `已停止 · ${elapsed}`;
  return `耗时 ${elapsed}`;
}

export default function ToolChips({
  activities,
  state,
  startedAt,
  completedAt,
  currentFocus,
}: {
  activities: ToolActivity[];
  state: TurnState;
  startedAt?: string;
  completedAt?: string;
  currentFocus?: string;
}) {
  const active = state === "running";
  const elapsed = useTurnDuration(startedAt, completedAt, active);
  const [open, setOpen] = useState(active);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  useEffect(() => setOpen(active), [active]);

  const toggleRow = (id: string) => setOpenRows((current) => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <div className="w-full max-w-80">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-control px-1.5 py-1 text-[12.5px] text-ink-2 transition-colors duration-100 hover:bg-hover-2"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="transition-transform duration-200" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }}>
          <path d="M6 9l6 6 6-6" />
        </svg>
        <span className="tabular-nums">{headerLabel(state, elapsed)}</span>
      </button>

      {open ? <div className="mt-1.5 flex flex-col gap-1 px-0.5">
        {activities.map((activity) => {
          const rowOpen = openRows.has(activity.id);
          const icon = iconFor(activity.name);
          const progress = activity.progress?.total
            ? `${activity.progress.current ?? 0}/${activity.progress.total}`
            : null;
          return (
            <div key={activity.id} style={{ animation: "fade-up 300ms cubic-bezier(0.23,1,0.32,1) both" }}>
              <button
                type="button"
                aria-expanded={rowOpen}
                onClick={() => toggleRow(activity.id)}
                className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-[3px] text-left transition-colors duration-100 hover:bg-hover-2"
              >
                <span className="relative flex size-4 shrink-0 items-center justify-center text-ink-3">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill={icon === "think" ? "currentColor" : "none"} stroke="currentColor" className={`transition-opacity duration-100 group-hover/row:opacity-0 ${rowOpen ? "opacity-0" : ""}`}>
                    {Icons[icon]}
                  </svg>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={`absolute transition-[opacity,transform] duration-150 group-hover/row:opacity-100 ${rowOpen ? "opacity-100" : "opacity-0"}`} style={{ transform: rowOpen ? "rotate(0deg)" : "rotate(-90deg)" }}>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </span>
                <span className="min-w-0 shrink truncate text-[12.5px] font-medium text-ink">{activity.label}</span>
                <span className="inline-flex h-5.5 min-w-0 flex-1 items-center truncate rounded-chip bg-field px-1.5 text-[11.5px] text-ink-2 shadow-hairline transition-colors duration-100 hover:bg-hover-2">
                  {activity.progress?.label ?? STATE_LABEL[activity.state]}
                </span>
              </button>

              {rowOpen && (activity.detail || progress) ? <div className="mt-0.5 mb-1 ml-2 flex flex-col gap-0.5 border-l border-line py-0.5 pl-3.5">
                {activity.detail ? <span className="whitespace-normal text-[11.5px] leading-[1.6] text-ink-2">{activity.detail}</span> : null}
                {progress ? <span className="truncate font-mono text-[11.5px] leading-[1.6] text-ink-2">{progress}</span> : null}
              </div> : null}
            </div>
          );
        })}

        {currentFocus ? <div className="mt-1.5 border-t border-line pt-2.5 text-[11.5px] text-ink-3">{currentFocus}</div> : null}
      </div> : null}
    </div>
  );
}
