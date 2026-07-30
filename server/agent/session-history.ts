import type { AgentInputItem } from "@openai/agents";

export const threadMemorySummaryPrefix = "此前对话的结构化摘要：\n";

function itemType(item: AgentInputItem) {
  return (item as { type?: string }).type;
}

function itemCallId(item: AgentInputItem) {
  return (item as { callId?: string }).callId;
}

export function isThreadMemorySummaryItem(item: AgentInputItem) {
  const message = item as { role?: string; content?: unknown };
  return message.role === "system"
    && typeof message.content === "string"
    && message.content.startsWith(threadMemorySummaryPrefix);
}

export function withoutThreadMemorySummaryItems(items: AgentInputItem[]) {
  return items.filter((item) => !isThreadMemorySummaryItem(item));
}

export function threadMemorySummaryItem(summary: string): AgentInputItem {
  return { role: "system", content: `${threadMemorySummaryPrefix}${summary}` } as AgentInputItem;
}

function protocolUnits(history: AgentInputItem[]) {
  const units: AgentInputItem[][] = [];
  for (let index = 0; index < history.length;) {
    const item = history[index];
    if (itemType(item) === "function_call") {
      const calls: AgentInputItem[] = [];
      while (index < history.length && itemType(history[index]) === "function_call") {
        calls.push(history[index]);
        index += 1;
      }
      const results: AgentInputItem[] = [];
      while (index < history.length && itemType(history[index]) === "function_call_result") {
        results.push(history[index]);
        index += 1;
      }
      const resultIds = new Set(results.map(itemCallId).filter(Boolean));
      const pairedCalls = calls.filter((call) => resultIds.has(itemCallId(call)));
      const callIds = new Set(pairedCalls.map(itemCallId).filter(Boolean));
      const pairedResults = results.filter((result) => callIds.has(itemCallId(result)));
      if (pairedCalls.length) units.push([...pairedCalls, ...pairedResults]);
      continue;
    }
    if (itemType(item) === "function_call_result") {
      index += 1;
      continue;
    }
    units.push([item]);
    index += 1;
  }
  return units;
}

export function selectProtocolSafeSessionHistory(args: {
  history: AgentInputItem[];
  current: AgentInputItem[];
  summary?: string;
  keepRecentItems?: number;
  characterBudget?: number;
}) {
  const keepRecentItems = args.keepRecentItems ?? 24;
  const characterBudget = args.characterBudget ?? 48_000;
  const history = withoutThreadMemorySummaryItems(args.history);
  const units = protocolUnits(history);
  const selected: AgentInputItem[][] = [];
  let selectedItems = 0;
  let used = JSON.stringify(args.current).length + (args.summary?.length ?? 0);

  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    const size = JSON.stringify(unit).length;
    const exceedsLimit = selected.length > 0 && (
      selectedItems + unit.length > keepRecentItems || used + size > characterBudget
    );
    if (exceedsLimit) break;
    selected.unshift(unit);
    selectedItems += unit.length;
    used += size;
  }

  return selected.flat();
}
