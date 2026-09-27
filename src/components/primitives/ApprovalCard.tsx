"use client";

type Option = { id: string; title: string; description?: string };

type Props = {
  title: string;
  description?: string;
  options?: Option[];
  busy?: boolean;
  primaryLabel?: string;
  secondaryLabel?: string;
  onPrimary?: () => void;
  onSecondary?: () => void;
  onSelect?: (id: string) => void;
  children?: React.ReactNode;
};

/** Human-in-the-loop surface. Its placement is controlled by PromptBar. */
export default function ApprovalCard({ title, description, options = [], busy = false, primaryLabel, secondaryLabel, onPrimary, onSecondary, onSelect, children }: Props) {
  return (
    <section className="flex max-h-[min(68dvh,720px)] min-h-0 w-full flex-col overflow-hidden rounded-card bg-surface shadow-card" aria-label={title}>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-approval-scroll>
        <div className="primitive-card-pad">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-[6px] bg-accent-tint text-accent-ink" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z" /></svg></span>
            <div className="min-w-0"><h3 className="text-[13px] font-medium text-ink">{title}</h3>{description ? <p className="mt-0.5 text-[12px] leading-relaxed text-ink-3">{description}</p> : null}</div>
          </div>
          {options.length ? <div className="mt-3 flex flex-col gap-0.5">{options.map((option) => <button key={option.id} type="button" disabled={busy} onClick={() => onSelect?.(option.id)} className="-mx-1.5 flex items-start gap-2 rounded-control px-1.5 py-1.5 text-left transition-colors duration-100 hover:bg-hover active:scale-[0.96]"><span className="mt-1 size-1.5 shrink-0 rounded-full bg-ink-3" /><span><strong className="block text-[12.5px] font-medium text-ink">{option.title}</strong>{option.description ? <small className="block text-[11.5px] leading-relaxed text-ink-3">{option.description}</small> : null}</span></button>)}</div> : null}
        </div>
        {children ? <div className="border-t border-line p-2.5">{children}</div> : null}
      </div>
      {primaryLabel || secondaryLabel ? <footer className="primitive-card-footer flex shrink-0 items-center justify-end gap-1.5 border-t border-line">
        {secondaryLabel ? <button type="button" disabled={busy} onClick={onSecondary} className="h-7 rounded-control bg-surface px-3 text-[12px] font-medium text-ink-2 shadow-btn transition-[background-color,transform] duration-150 hover:bg-inset active:scale-[0.96] disabled:opacity-50">{secondaryLabel}</button> : null}
        {primaryLabel ? <button type="button" disabled={busy} onClick={onPrimary} className="h-7 rounded-control bg-ink px-3 text-[12px] font-medium text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.14)] transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.96] disabled:opacity-50">{busy ? "处理中…" : primaryLabel}</button> : null}
      </footer> : null}
    </section>
  );
}
