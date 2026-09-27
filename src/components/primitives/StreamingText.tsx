"use client";

import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Source = { id: string; title: string; url?: string | null; page?: number | null };
type Props = {
  content: string;
  streaming?: boolean;
  sources?: Source[];
  onCopy?: () => void;
  onRetry?: () => void;
  onBranch?: () => void;
  actions?: boolean;
};

function ActionIcon({ children }: { children: React.ReactNode }) {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

/** Renders the text already streamed by Pi. It never invents tokens or timing. */
function StreamingText({ content, streaming = false, sources = [], onCopy, onRetry, onBranch, actions = true }: Props) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const settled = !streaming;
  return (
    <div className="w-full min-w-0">
      <div className="beautiful-streaming-markdown text-[13.5px] leading-[1.65] text-ink">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
            table: ({ children }) => <div className="beautiful-markdown-table"><table>{children}</table></div>,
          }}
        >{content}</ReactMarkdown>
      </div>

      {settled && content && actions ? (
        <div className="mt-2 flex items-center gap-0.5" style={{ animation: "fade-in 180ms ease-out both" }}>
          {onCopy ? <button type="button" aria-label="复制回复" onClick={onCopy} className="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2"><ActionIcon><rect x="9" y="9" width="12" height="12" rx="2.5" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></ActionIcon></button> : null}
          {onRetry ? <button type="button" aria-label="重试" onClick={onRetry} className="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2"><ActionIcon><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" /></ActionIcon></button> : null}
          {onBranch ? <button type="button" aria-label="从此创建分支" onClick={onBranch} className="flex size-6 items-center justify-center rounded-[6px] text-ink-3 transition-colors duration-100 hover:bg-hover-2 hover:text-ink-2"><ActionIcon><circle cx="6" cy="5" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M8 9c4 0 4-3 8-3" /></ActionIcon></button> : null}
          {sources.length ? <button type="button" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen((value) => !value)} className="ml-1.5 flex items-center gap-1.5 rounded-[6px] px-1 py-0.5 text-left transition-colors duration-150 hover:bg-hover"><span className="flex -space-x-1" aria-hidden="true">{sources.slice(0, 3).map((source) => <span key={source.id} className="source-avatar flex size-3.5 items-center justify-center rounded-full bg-surface text-[8px] font-medium text-ink-2 shadow-[0_0_0_1.5px_var(--canvas)]">{source.title.slice(0, 1)}</span>)}</span><span className="text-[12px] text-ink-2">{sources.length} 个来源</span></button> : null}
        </div>
      ) : null}

      <div className="grid transition-[grid-template-rows,opacity] duration-300" style={{ gridTemplateRows: settled && sourcesOpen ? "1fr" : "0fr", opacity: settled && sourcesOpen ? 1 : 0, transitionTimingFunction: "cubic-bezier(0.23,1,0.32,1)" }}>
        <div className="overflow-hidden"><div className="mt-1.5 flex flex-col rounded-[10px] bg-inset p-1 shadow-hairline">
          {sources.map((source) => source.url ? <a key={source.id} href={source.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-[12px] text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink"><span className="animated-underline min-w-0 truncate">{source.title}</span></a> : <span key={source.id} className="flex items-center gap-2 rounded-[6px] px-1.5 py-1 text-[12px] text-ink-2">{source.title}{source.page ? ` · 第 ${source.page} 页` : ""}</span>)}
        </div></div>
      </div>
    </div>
  );
}

export default memo(StreamingText);
