import { useEffect, useState } from "react";

export function turnDurationMs(startedAt?: string | null, completedAt?: string | null, now = Date.now()) {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(started)) return 0;
  const ended = completedAt ? Date.parse(completedAt) : Number.NaN;
  return Math.max(0, (Number.isFinite(ended) ? ended : now) - started);
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

export function useTurnDuration(startedAt: string | undefined, completedAt: string | undefined, active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [active, startedAt]);
  return formatTurnDuration(turnDurationMs(startedAt, completedAt, now));
}
