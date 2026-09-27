"use client";

import { useLayoutEffect, useRef } from "react";

import {
  DEFAULT_THINKING_LEVEL,
  THINKING_LEVELS,
  parseThinkingLevel,
} from "../../lib/thinking-level.js";

type Upload = { id: string; title: string; status: string; last_error?: string | null };
type QueuedInput = { id: string; content: string; delivery: "steer" | "follow_up"; state?: string };
type ThinkingLevel = (typeof THINKING_LEVELS)[number]["value"];
type Props = {
  className?: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  onAttach?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  attachmentInputRef?: React.RefObject<HTMLInputElement | null>;
  uploads?: Upload[];
  onRemoveUpload?: (id: string) => void;
  onRetryUpload?: (id: string) => void;
  status: string;
  statusLabel?: string;
  thinkingLevel?: ThinkingLevel;
  onThinkingLevelChange?: (value: ThinkingLevel) => void;
  disabled?: boolean;
  sendDisabled?: boolean;
  uploadDisabled?: boolean;
  showAttachment?: boolean;
  placeholder?: string;
  queuedInputs?: QueuedInput[];
  queueDelivery?: "steer" | "follow_up";
  onQueueDeliveryChange?: (value: "steer" | "follow_up") => void;
  onClearQueuedInputs?: (scope: string) => void;
  children?: React.ReactNode;
};

function Icon({ children, size = 15, strokeWidth = 1.8 }: { children: React.ReactNode; size?: number; strokeWidth?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}

function ComposerPrimaryButton({
  running,
  hasDraft,
  sendDisabled,
  onSubmit,
  onStop,
}: {
  running: boolean;
  hasDraft: boolean;
  sendDisabled: boolean;
  onSubmit: () => void;
  onStop?: () => void;
}) {
  const stopping = running && !hasDraft;
  const iconMotion = "flex items-center justify-center transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]";
  return (
    <button
      type="button"
      aria-label={stopping ? "停止生成" : running ? "加入当前任务" : "发送"}
      disabled={stopping ? false : sendDisabled}
      onClick={stopping ? onStop : onSubmit}
      className="col-start-3 row-start-2 flex size-7 items-center justify-center rounded-[8px] transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.96]"
      style={{
        background: stopping || !sendDisabled ? "var(--ink)" : "var(--line-strong)",
        color: stopping || !sendDisabled ? "var(--surface)" : "var(--ink-2)",
      }}
    >
      <span className="relative flex size-4 items-center justify-center">
        <span className={`absolute ${iconMotion} ${stopping ? "scale-100 opacity-100 blur-0" : "scale-[0.25] opacity-0 blur-[4px]"}`}>
          <Icon size={13} strokeWidth={2.4}><rect x="6" y="6" width="12" height="12" rx="2" /></Icon>
        </span>
        <span className={`${iconMotion} ${stopping ? "scale-[0.25] opacity-0 blur-[4px]" : "scale-100 opacity-100 blur-0"}`}>
          <Icon size={16} strokeWidth={2.4}><path d="M12 19V5M5 12l7-7 7 7" /></Icon>
        </span>
      </span>
    </button>
  );
}

function ThinkingLevelSelect({
  value,
  onChange,
}: {
  value: ThinkingLevel;
  onChange?: (value: ThinkingLevel) => void;
}) {
  return (
    <span className="relative inline-flex h-7 w-fit max-w-full shrink-0 items-center">
      <select
        aria-label="思考强度"
        title="思考强度"
        value={value}
        onChange={(event) => onChange?.(parseThinkingLevel(event.target.value))}
        className="h-7 w-fit max-w-full cursor-pointer appearance-none rounded-[8px] bg-transparent py-0 pr-5 pl-1.5 text-[11px] font-medium text-ink-2 outline-none transition-colors duration-150 hover:bg-hover hover:text-ink"
      >
        {THINKING_LEVELS.map((item) => (
          <option key={item.value} value={item.value} title={item.description}>
            {item.label}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-1.5 text-ink-3">
        <Icon size={11} strokeWidth={2.2}><path d="M6 9l6 6 6-6" /></Icon>
      </span>
    </span>
  );
}

export default function PromptBar({
  className = "",
  value,
  onChange,
  onSubmit,
  onStop,
  onAttach,
  attachmentInputRef,
  uploads = [],
  onRemoveUpload,
  onRetryUpload,
  status,
  statusLabel,
  thinkingLevel = DEFAULT_THINKING_LEVEL,
  onThinkingLevelChange,
  disabled = false,
  sendDisabled = false,
  uploadDisabled = false,
  showAttachment = true,
  placeholder = "Write a message…",
  queuedInputs = [],
  queueDelivery = "steer",
  onQueueDeliveryChange,
  onClearQueuedInputs,
  children,
}: Props) {
  const internalInputRef = useRef<HTMLTextAreaElement>(null);
  const running = status === "streaming";

  useLayoutEffect(() => {
    const input = internalInputRef.current;
    if (!input) return;
    input.style.height = "0px";
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 46), 120)}px`;
    input.style.overflowY = input.scrollHeight > 120 ? "auto" : "hidden";
  }, [value]);

  return (
    <div className={`w-full ${className}`} data-promptbar>
      {children ? <div className="mb-2" style={{ animation: "fade-up 260ms cubic-bezier(0.23,1,0.32,1) both" }}>{children}</div> : null}
      {queuedInputs.length ? <div className="mb-2 rounded-card bg-inset p-2 shadow-hairline" role="status"><div className="flex items-center justify-between px-1 text-[11.5px] font-medium text-ink-2"><span>已加入 Pi 队列</span><button type="button" onClick={() => onClearQueuedInputs?.("all")} className="rounded-[6px] px-1.5 py-0.5 text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink">清空</button></div><div className="mt-1 flex flex-col gap-1">{queuedInputs.map((item) => <p key={item.id} className="truncate rounded-[6px] bg-surface px-2 py-1 text-[11.5px] text-ink-2 shadow-hairline"><span className="mr-1.5 font-mono text-[10px] text-ink-3">{item.delivery === "steer" ? "当前轮" : "后续轮"}</span>{item.content}</p>)}</div></div> : null}

      <div className="relative isolate flex flex-col gap-1.5 overflow-hidden rounded-[14px] border border-line bg-surface p-1.5 shadow-card transition-[border-color,border-radius] duration-150 focus-within:border-line-strong">
        {uploads.length ? <div className="flex flex-wrap gap-1.5 px-0.5 pt-0.5">{uploads.map((upload) => {
          const failed = upload.status === "failed";
          const label = upload.status === "ready" ? "可用" : failed ? "失败" : upload.status === "processing" ? "解析中" : "排队中";
          return <span key={upload.id} className="flex h-6.5 max-w-full items-center gap-1.5 rounded-chip bg-field py-1 pr-1 pl-1.5 text-[11.5px] text-ink-2 shadow-hairline" style={{ animation: "pop-in 200ms cubic-bezier(0.23,1,0.32,1) both" }}><Icon size={12}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></Icon><span className="max-w-36 truncate">{upload.title}</span><small className={failed ? "text-red" : "text-ink-3"}>{label}</small>{failed && upload.last_error !== "knowledge_source_empty" ? <button type="button" onClick={() => onRetryUpload?.(upload.id)} aria-label={`重试 ${upload.title}`} className="flex size-6 items-center justify-center rounded-[5px] text-ink-3 transition-colors duration-100 hover:bg-line/70 hover:text-ink"><Icon size={11}><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></Icon></button> : null}<button type="button" onClick={() => onRemoveUpload?.(upload.id)} aria-label={`移除 ${upload.title}`} className="flex size-6 items-center justify-center rounded-[5px] text-ink-3 transition-colors duration-100 hover:bg-line/70 hover:text-ink"><Icon size={10} strokeWidth={2.5}><path d="M18 6L6 18M6 6l12 12" /></Icon></button></span>;
        })}</div> : null}

        <div className="grid grid-cols-[28px_minmax(0,1fr)_28px] items-end gap-x-1 gap-y-1.5">
          <textarea ref={internalInputRef} rows={2} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!sendDisabled) onSubmit(); } }} placeholder={placeholder} aria-label="向备课助手提问" className="col-span-full col-start-1 row-start-1 min-h-[46px] min-w-0 w-full resize-none bg-transparent px-1 py-[5px] text-[13px] leading-[18px] text-ink outline-none [overflow-wrap:anywhere] placeholder:text-ink-3 disabled:opacity-50" />
          {showAttachment ? <><input ref={attachmentInputRef} className="sr-only" type="file" accept=".pdf,.docx,.pptx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain,text/markdown" onChange={onAttach} aria-label="选择备课资料" /><button type="button" aria-label="添加附件" disabled={uploadDisabled} onClick={() => attachmentInputRef?.current?.click()} className="col-start-1 row-start-2 flex size-7 items-center justify-center rounded-[8px] text-ink-3 transition-[background-color,color,transform] duration-150 hover:bg-hover hover:text-ink active:scale-[0.96] disabled:opacity-35"><Icon size={16} strokeWidth={2}><path d="M12 5v14M5 12h14" /></Icon></button></> : <span className="col-start-1 row-start-2" />}
          <div className="col-start-2 row-start-2 flex h-7 min-w-0 items-center gap-1">
            {running
              ? <button type="button" aria-label={queueDelivery === "steer" ? "发送为本轮插话" : "发送到下一轮"} title={queueDelivery === "steer" ? "本轮插话：让 Pi 在当前 Turn 中接收这条消息" : "下一轮：当前 Turn 完成后再处理这条消息"} onClick={() => onQueueDeliveryChange?.(queueDelivery === "steer" ? "follow_up" : "steer")} className="h-7 w-fit shrink-0 rounded-[8px] px-1.5 text-[11px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink">{queueDelivery === "steer" ? "本轮插话" : "下一轮"}</button>
              : <ThinkingLevelSelect value={thinkingLevel} onChange={onThinkingLevelChange} />}
            {!running && statusLabel ? <span className="min-w-0 truncate text-[11px] text-ink-3" role="status">{statusLabel}</span> : null}
          </div>
          <ComposerPrimaryButton running={running} hasDraft={Boolean(value.trim())} sendDisabled={sendDisabled} onSubmit={onSubmit} onStop={onStop} />
        </div>
      </div>
    </div>
  );
}
