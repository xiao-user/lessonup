"use client";

import { useEffect, useState } from "react";

import { DisclosureChevron, DisclosureLabel } from "./DisclosureLabel.js";

/* ─────────────────────────────────────────────────────────
 * TOOL CHIPS
 * The Beautiful UI primitive, driven by normalized public Pi
 * events instead of the repository's timed demo rows.
 * Duration belongs on ThinkingTrace, not on this list.
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

export type TurnState = "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";

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

export function activitySummary(activities: ToolActivity[], state: TurnState, turnCount?: number) {
  const tools = `${activities.length} 个工具调用`;
  const turns = turnCount && turnCount > 1 ? ` · ${turnCount} 轮` : "";
  if (state === "running") return `正在处理 · ${tools}${turns}`;
  if (state === "awaiting_approval") return `等待确认 · ${tools}${turns}`;
  if (state === "failed") return `失败 · ${tools}${turns}`;
  if (state === "cancelled") return `已停止 · ${tools}${turns}`;
  return `${tools}${turns}`;
}

export default function ToolChips({
  activities,
  state,
  turnCount,
  plain = false,
}: {
  activities: ToolActivity[];
  state: TurnState;
  turnCount?: number;
  plain?: boolean;
}) {
  const unsettled = state === "running" || state === "awaiting_approval";
  const [open, setOpen] = useState(true);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (unsettled) setOpen(true);
  }, [unsettled]);

  const toggleRow = (id: string) => setOpenRows((current) => {
    const next = new Set(current);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <div className="w-full max-w-80">
      {plain ? null : (
        <DisclosureLabel open={open} onToggle={() => setOpen((current) => !current)}>
          {activitySummary(activities, state, turnCount)}
        </DisclosureLabel>
      )}

      {open || plain ? <div className={`${plain ? "" : "mt-1.5 "}flex flex-col gap-1 px-0.5`}>
        {activities.map((activity) => {
          const rowOpen = openRows.has(activity.id);
          const icon = iconFor(activity.name);
          const progress = activity.progress?.total
            ? `${activity.progress.current ?? 0}/${activity.progress.total}`
            : null;
          return (
            <div key={activity.id}>
              <button
                type="button"
                aria-expanded={rowOpen}
                onClick={() => toggleRow(activity.id)}
                className="group/row -mx-[3px] flex h-7 w-[calc(100%+6px)] min-w-0 items-center gap-2 rounded-control px-[3px] text-left transition-colors duration-100 hover:bg-hover-2"
              >
                <span className="relative flex size-4 shrink-0 items-center justify-center text-[12.5px] text-ink-3">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill={icon === "think" ? "currentColor" : "none"} stroke="currentColor" className={`transition-opacity duration-100 group-hover/row:opacity-0 ${rowOpen ? "opacity-0" : ""}`}>
                    {Icons[icon]}
                  </svg>
                  <DisclosureChevron
                    open={rowOpen}
                    overlay
                    className={`group-hover/row:opacity-100 ${rowOpen ? "opacity-100" : "opacity-0"}`}
                  />
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
      </div> : null}
    </div>
  );
}
