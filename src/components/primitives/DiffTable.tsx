"use client";

import { useState } from "react";

export type DiffRow = {
  key: string;
  fieldLabel: string;
  target?: string | null;
  before: string;
  after: string;
  fullBefore?: string;
  fullAfter?: string;
  isNoEffect?: boolean;
  isTruncated?: boolean;
  onNavigate?: (() => void) | null;
};

export default function DiffTable({ title = "建议修改", rows }: { title?: string; rows: DiffRow[] }) {
  const [full, setFull] = useState(false);
  return (
    <div className="w-full overflow-hidden rounded-card bg-surface shadow-card">
      <div className="primitive-card-bar flex items-center justify-between border-b border-line">
        <span className="text-[12.5px] font-medium text-ink">{title}</span>
        {rows.some((row) => row.isTruncated) ? <button type="button" onClick={() => setFull((value) => !value)} className="rounded-[6px] px-1.5 py-0.5 text-[11px] text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink">{full ? "收起" : "完整对比"}</button> : null}
      </div>
      <div className="divide-y divide-line">
        {rows.map((row) => (
          <section key={row.key} className="p-3">
            <header className="mb-2 flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-[12px] font-medium text-ink-2">{row.target ? `${row.target} · ` : ""}{row.fieldLabel}</span>
              {row.onNavigate ? <button type="button" onClick={row.onNavigate} className="shrink-0 rounded-[6px] px-1.5 py-0.5 text-[11px] text-accent-ink transition-colors duration-150 hover:bg-accent-tint">定位</button> : null}
            </header>
            {row.isNoEffect ? <p className="text-[12px] text-ink-3">这项建议不产生实际内容变化。</p> : (
              <div className="grid gap-1.5 font-mono text-[11.5px] leading-relaxed">
                <div className="rounded-[6px] bg-red-tint px-2.5 py-2 text-red"><span className="mr-2 select-none opacity-60">−</span><del className="no-underline whitespace-pre-wrap">{full && row.fullBefore !== undefined ? row.fullBefore || "（新增内容）" : row.before || "（新增内容）"}</del></div>
                <div className="rounded-[6px] bg-green-tint px-2.5 py-2 text-green"><span className="mr-2 select-none opacity-60">+</span><ins className="no-underline whitespace-pre-wrap">{full && row.fullAfter !== undefined ? row.fullAfter || "（删除内容）" : row.after || "（删除内容）"}</ins></div>
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
